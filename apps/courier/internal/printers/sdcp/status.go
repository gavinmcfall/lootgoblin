package sdcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
	"github.com/gorilla/websocket"
)

// ---------------------------------------------------------------------------
// SDCP status payload types
// ---------------------------------------------------------------------------

// sdcpStatusPayload is the top-level shape of a push frame on
// sdcp/status/<MainboardID>.
type sdcpStatusPayload struct {
	Topic  string         `json:"Topic"`
	Status *sdcpStatusObj `json:"Status"`
}

type sdcpStatusObj struct {
	PrintInfo *sdcpPrintInfo `json:"PrintInfo"`
}

type sdcpPrintInfo struct {
	Status            *int    `json:"Status"`
	CurrentLayer      *int    `json:"CurrentLayer"`
	TotalLayer        *int    `json:"TotalLayer"`
	Filename          *string `json:"Filename"`
	TaskID            *string `json:"TaskId"`
	RemainTime        *int    `json:"RemainTime"`
	ErrorStatusReason any     `json:"ErrorStatusReason"` // string | number | nil
}

// ---------------------------------------------------------------------------
// Pure state mapping
// ---------------------------------------------------------------------------

// sdcpStatusKind mirrors the StatusEventKind strings accepted by the central API.
type sdcpStatusKind string

const (
	sdcpProgress      sdcpStatusKind = "progress"
	sdcpCompleted     sdcpStatusKind = "completed"
	sdcpFirmwareError sdcpStatusKind = "firmware_error"
	sdcpCancelled     sdcpStatusKind = "cancelled"
)

// mapSdcpStatus maps PrintInfo.Status to a kind.
// Returns ("", false) for states that should not surface an event.
//
// Mapping (V2-005f-CF-5a):
//
//	0 → nil (IDLE / stop)
//	1 → progress
//	2 → completed (COMPLETE)
//	3 → firmware_error (FAIL)
//	8 → cancelled (STOPPED — operator stop)
//	9 → completed (COMPLETE alt)
//	other → nil (LIFTING, PAUSING, PAUSED, reserved, FILE_CHECKING)
func mapSdcpStatus(status int) (sdcpStatusKind, bool) {
	switch status {
	case 0:
		return "", false // IDLE
	case 1:
		return sdcpProgress, true
	case 2:
		return sdcpCompleted, true
	case 3:
		return sdcpFirmwareError, true
	case 8:
		return sdcpCancelled, true
	case 9:
		return sdcpCompleted, true
	default:
		return "", false
	}
}

// sdcpReportIntent is a pure-value description of a central report to send.
type sdcpReportIntent struct {
	isStatusEvent bool
	eventKind     sdcpStatusKind
	remoteJobRef  string
	progressPct   *float64
	layerNum      *int
	totalLayers   *int
	remainingMin  *float64
	errorCode     string
	rawPayload    any
	occurredAt    time.Time

	// terminal phase
	isCompleted bool
	isFailed    bool
	failReason  string
	failDetails string
}

// buildSdcpIntents converts a parsed sdcpStatusPayload + resolved kind into
// the list of central reports to send.
//
// SDCP has no measured consumption (resin printers do not track per-slot grams),
// so completed reports are always sent without materials_used.
func buildSdcpIntents(payload sdcpStatusPayload, kind sdcpStatusKind, now time.Time) []sdcpReportIntent {
	pi := &sdcpPrintInfo{}
	if payload.Status != nil && payload.Status.PrintInfo != nil {
		pi = payload.Status.PrintInfo
	}

	// remoteJobRef: prefer Filename, fall back to TaskId.
	remoteJobRef := ""
	if pi.Filename != nil && *pi.Filename != "" {
		remoteJobRef = *pi.Filename
	} else if pi.TaskID != nil {
		remoteJobRef = *pi.TaskID
	}

	// progressPct: layer ratio.
	var progressPct *float64
	if pi.CurrentLayer != nil && pi.TotalLayer != nil && *pi.TotalLayer > 0 {
		pct := float64(*pi.CurrentLayer) / float64(*pi.TotalLayer) * 100
		rounded := float64(int(pct + 0.5))
		progressPct = &rounded
	}

	// layerNum + totalLayers.
	var layerNum *int
	var totalLayers *int
	if pi.CurrentLayer != nil {
		v := *pi.CurrentLayer
		layerNum = &v
	}
	if pi.TotalLayer != nil {
		v := *pi.TotalLayer
		totalLayers = &v
	}

	// remainingMin: RemainTime is in seconds.
	var remainingMin *float64
	if pi.RemainTime != nil && *pi.RemainTime >= 0 {
		m := float64(*pi.RemainTime) / 60.0
		rounded := float64(int(m + 0.5))
		remainingMin = &rounded
	}

	// errorCode: from ErrorStatusReason on firmware_error.
	var errorCode string
	if kind == sdcpFirmwareError && pi.ErrorStatusReason != nil {
		switch v := pi.ErrorStatusReason.(type) {
		case string:
			if v != "" {
				errorCode = v
			}
		case float64:
			errorCode = fmt.Sprintf("%d", int(v))
		case int:
			errorCode = fmt.Sprintf("%d", v)
		}
	}

	statusIntent := sdcpReportIntent{
		isStatusEvent: true,
		eventKind:     kind,
		remoteJobRef:  remoteJobRef,
		progressPct:   progressPct,
		layerNum:      layerNum,
		totalLayers:   totalLayers,
		remainingMin:  remainingMin,
		errorCode:     errorCode,
		rawPayload:    payload,
		occurredAt:    now,
	}

	var intents []sdcpReportIntent
	intents = append(intents, statusIntent)

	// Terminal phase reports.
	switch kind {
	case sdcpCompleted:
		// No measured consumption for resin.
		intents = append(intents, sdcpReportIntent{isCompleted: true})
	case sdcpCancelled:
		intents = append(intents, sdcpReportIntent{
			isFailed:    true,
			failReason:  "rejected",
			failDetails: "cancelled",
		})
	case sdcpFirmwareError:
		details := errorCode
		if details == "" {
			details = "firmware error"
		}
		intents = append(intents, sdcpReportIntent{
			isFailed:    true,
			failReason:  "rejected",
			failDetails: details,
		})
	}

	return intents
}

// sendSdcpIntent converts an sdcpReportIntent to a central.StatusReport and
// calls reporter.ReportStatus.
func sendSdcpIntent(ctx context.Context, reporter printers.Reporter, jobID string, intent sdcpReportIntent, log *slog.Logger) error {
	var report central.StatusReport

	switch {
	case intent.isStatusEvent:
		evt := central.StatusEventPayload{
			Kind:         string(intent.eventKind),
			RemoteJobRef: intent.remoteJobRef,
			RawPayload:   intent.rawPayload,
			OccurredAt:   intent.occurredAt.UTC().Format(time.RFC3339),
		}
		if intent.progressPct != nil {
			p := *intent.progressPct
			evt.ProgressPct = &p
		}
		if intent.layerNum != nil {
			v := *intent.layerNum
			evt.LayerNum = &v
		}
		if intent.totalLayers != nil {
			v := *intent.totalLayers
			evt.TotalLayers = &v
		}
		if intent.remainingMin != nil {
			v := *intent.remainingMin
			evt.RemainingMin = &v
		}
		if intent.errorCode != "" {
			evt.ErrorCode = intent.errorCode
		}
		report = central.StatusEventReport(jobID, evt)

	case intent.isCompleted:
		// No materials_used for resin — terminal completed without consumption.
		report = central.CompletedReport(jobID, nil)

	case intent.isFailed:
		report = central.FailedReport(jobID, intent.failReason, intent.failDetails)

	default:
		log.Warn("sdcp-status: unknown reportIntent shape", "jobID", jobID)
		return nil
	}

	return reporter.ReportStatus(ctx, report)
}

// ---------------------------------------------------------------------------
// WS subscribe + read loop
// ---------------------------------------------------------------------------

// Subscribe opens a WebSocket to the SDCP printer, sends a Cmd 0 subscribe,
// and relays StatusEvents to reporter until ctx is cancelled or the connection
// is dropped (returns error so orchestrator can reconnect).
//
// Keepalive: sends a WS ping every 30 s (printer drops after 60 s idle).
func Subscribe(
	ctx context.Context,
	cfg ConnectionConfig,
	jobID string,
	reporter printers.Reporter,
	log *slog.Logger,
) error {
	return subscribeWithDialer(ctx, cfg, jobID, reporter, log, nil)
}

// subscribeWithDialer is the internal implementation; dialFn is injectable for tests.
func subscribeWithDialer(
	ctx context.Context,
	cfg ConnectionConfig,
	jobID string,
	reporter printers.Reporter,
	log *slog.Logger,
	dialFn func(rawURL string) (wsConn, error),
) error {
	if log == nil {
		log = slog.Default()
	}

	rawURL := fmt.Sprintf("ws://%s:%d/websocket", cfg.IP, cfg.Port)

	var conn wsConn
	if dialFn != nil {
		var err error
		conn, err = dialFn(rawURL)
		if err != nil {
			return fmt.Errorf("sdcp status: dial %s: %w", rawURL, err)
		}
	} else {
		dialer := websocket.Dialer{
			HandshakeTimeout: 10 * time.Second,
		}
		wsC, _, err := dialer.DialContext(ctx, rawURL, http.Header{})
		if err != nil {
			return fmt.Errorf("sdcp status: dial %s: %w", rawURL, err)
		}
		conn = &gorillaConn{conn: wsC}
	}
	defer conn.Close()

	// Send Cmd 0 subscribe (best-effort; many firmwares auto-push).
	subMsg, err := buildSubscribeMessage(cfg.MainboardID, newUUID(), newUUID(), time.Now().Unix())
	if err == nil {
		if werr := conn.WriteMessage(subMsg); werr != nil {
			log.Warn("sdcp-status: subscribe send failed", "ip", cfg.IP, "err", werr.Error())
		}
	}
	log.Info("sdcp status: subscribed", "url", rawURL, "jobID", jobID)

	expectedTopic := fmt.Sprintf("sdcp/status/%s", cfg.MainboardID)

	frameCh := make(chan []byte, 128)
	readErr := make(chan error, 1)

	go func() {
		for {
			msg, err := conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}
			frameCh <- msg
		}
	}()

	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	for {
		// Drain frames before checking other channels.
		select {
		case raw := <-frameCh:
			processSdcpFrame(ctx, raw, expectedTopic, reporter, jobID, log)
			continue
		default:
		}

		select {
		case <-ctx.Done():
			log.Info("sdcp status: context cancelled", "jobID", jobID)
			return ctx.Err()

		case err := <-readErr:
			// Drain remaining buffered frames.
			for {
				select {
				case raw := <-frameCh:
					processSdcpFrame(ctx, raw, expectedTopic, reporter, jobID, log)
				default:
					return fmt.Errorf("sdcp status: read: %w", err)
				}
			}

		case raw := <-frameCh:
			processSdcpFrame(ctx, raw, expectedTopic, reporter, jobID, log)

		case <-pingTicker.C:
			// Send a WS ping to keep the connection alive.
			if wc, ok := conn.(*gorillaConn); ok {
				_ = wc.conn.WriteMessage(websocket.PingMessage, nil)
			}
		}
	}
}

// processSdcpFrame parses one raw WebSocket message and routes it.
func processSdcpFrame(
	ctx context.Context,
	raw []byte,
	expectedTopic string,
	reporter printers.Reporter,
	jobID string,
	log *slog.Logger,
) {
	var payload sdcpStatusPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		log.Warn("sdcp-status: unparseable frame", "err", err)
		return
	}

	// Filter to our topic.
	if payload.Topic != expectedTopic {
		return
	}
	if payload.Status == nil || payload.Status.PrintInfo == nil {
		return
	}
	if payload.Status.PrintInfo.Status == nil {
		return
	}

	kind, ok := mapSdcpStatus(*payload.Status.PrintInfo.Status)
	if !ok {
		return
	}

	intents := buildSdcpIntents(payload, kind, time.Now())
	for _, intent := range intents {
		if err := sendSdcpIntent(ctx, reporter, jobID, intent, log); err != nil {
			log.Warn("sdcp-status: report failed", "err", err, "jobID", jobID)
		}
	}
}
