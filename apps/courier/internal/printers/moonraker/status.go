package moonraker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// ---------------------------------------------------------------------------
// Reporter interface — satisfied by *central.Client, injectable in tests.
// ---------------------------------------------------------------------------

// Reporter is the minimal interface the status subscriber needs to call back to
// the central instance.  *central.Client satisfies this interface.
type Reporter interface {
	ReportStatus(ctx context.Context, payload central.StatusReport) error
}

// ---------------------------------------------------------------------------
// wsConn — thin interface over the gorilla websocket.Conn for test injection.
// ---------------------------------------------------------------------------

// wsConn abstracts a WebSocket connection so tests can inject a fake.
type wsConn interface {
	ReadMessage() ([]byte, error)
	WriteMessage([]byte) error
	Close() error
}

// ---------------------------------------------------------------------------
// Subscribe message
// ---------------------------------------------------------------------------

const subscribeRequestID = 1

// subscribeMessage is the JSON-RPC request sent once on open.
var subscribeMessage = mustMarshal(map[string]any{
	"jsonrpc": "2.0",
	"method":  "printer.objects.subscribe",
	"params": map[string]any{
		"objects": map[string]any{
			"print_stats":    []string{"state", "filename", "print_duration", "total_duration", "filament_used", "info", "message"},
			"display_status": []string{"progress", "message"},
			"virtual_sdcard": []string{"progress"},
			"webhooks":       []string{"state"},
		},
	},
	"id": subscribeRequestID,
})

func mustMarshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("moonraker: marshal subscribe message: %v", err))
	}
	return b
}

// ---------------------------------------------------------------------------
// Incoming frame types
// ---------------------------------------------------------------------------

// moonrakerFrame is the top-level JSON-RPC shape for incoming messages.
type moonrakerFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	ID      *int            `json:"id"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
}

// moonrakerPrintStats mirrors the fields we care about in print_stats.
type moonrakerPrintStats struct {
	State          string   `json:"state"`
	Filename       string   `json:"filename"`
	PrintDuration  float64  `json:"print_duration"`
	TotalDuration  float64  `json:"total_duration"`
	FilamentUsed   *float64 `json:"filament_used"`
	Message        string   `json:"message"`
}

// moonrakerDisplayStatus mirrors display_status.
type moonrakerDisplayStatus struct {
	Progress *float64 `json:"progress"`
	Message  string   `json:"message"`
}

// moonrakerVirtualSDCard mirrors virtual_sdcard.
type moonrakerVirtualSDCard struct {
	Progress *float64 `json:"progress"`
}

// moonrakerStatusPayload is the object at params[0] in notify_status_update.
type moonrakerStatusPayload struct {
	PrintStats    *moonrakerPrintStats    `json:"print_stats"`
	DisplayStatus *moonrakerDisplayStatus `json:"display_status"`
	VirtualSDCard *moonrakerVirtualSDCard `json:"virtual_sdcard"`
}

// moonrakerHistoryJob is the job object in notify_history_changed.
type moonrakerHistoryJob struct {
	JobID         string   `json:"job_id"`
	Filename      string   `json:"filename"`
	Status        string   `json:"status"`
	FilamentUsed  *float64 `json:"filament_used"`
	TotalDuration float64  `json:"total_duration"`
	PrintDuration float64  `json:"print_duration"`
}

// moonrakerHistoryEntry is params[0] in notify_history_changed.
type moonrakerHistoryEntry struct {
	Action string               `json:"action"`
	Job    *moonrakerHistoryJob `json:"job"`
}

// ---------------------------------------------------------------------------
// State mappings (pure — no I/O, fully testable)
// ---------------------------------------------------------------------------

// statusEventKind mirrors the set of kinds the central API accepts.
type statusEventKind string

const (
	kindProgress      statusEventKind = "progress"
	kindPaused        statusEventKind = "paused"
	kindCompleted     statusEventKind = "completed"
	kindCancelled     statusEventKind = "cancelled"
	kindFirmwareError statusEventKind = "firmware_error"
	kindFailed        statusEventKind = "failed"
)

// mapPrintStatsState maps a Klipper print_stats.state string to a kind.
// Returns ("", false) for states that should be ignored (e.g. "standby").
func mapPrintStatsState(state string) (statusEventKind, bool) {
	switch state {
	case "printing":
		return kindProgress, true
	case "paused":
		return kindPaused, true
	case "complete":
		return kindCompleted, true
	case "cancelled":
		return kindCancelled, true
	case "error":
		return kindFirmwareError, true
	default:
		// "standby" and anything unknown → ignore
		return "", false
	}
}

// historyMapping holds the derived kind + optional errorCode from a history job status.
type historyMapping struct {
	kind      statusEventKind
	errorCode string
}

// mapHistoryStatus maps a Moonraker history job.status to a historyMapping.
// Returns (historyMapping{}, false) when status is empty/unrecognised-as-null
// (i.e. we should ignore the event).
func mapHistoryStatus(status string) (historyMapping, bool) {
	switch status {
	case "completed":
		return historyMapping{kind: kindCompleted}, true
	case "cancelled", "interrupted":
		return historyMapping{kind: kindCancelled}, true
	case "klippy_shutdown", "klippy_disconnect", "server_exit":
		return historyMapping{kind: kindFirmwareError, errorCode: status}, true
	case "error":
		return historyMapping{kind: kindFirmwareError}, true
	case "":
		return historyMapping{}, false
	default:
		return historyMapping{kind: kindFailed}, true
	}
}

// ---------------------------------------------------------------------------
// Filament mm → grams conversion
// ---------------------------------------------------------------------------

// filamentMmToGrams converts a filament length (mm) to grams.
// Formula: volume_mm3 = π * (diameter_mm/2)^2 * length_mm
//          volume_cm3 = volume_mm3 / 1000
//          grams      = volume_cm3 * density_g_cm3
func filamentMmToGrams(lengthMm, diameterMm, densityGCm3 float64) float64 {
	radius := diameterMm / 2.0
	volumeMm3 := math.Pi * radius * radius * lengthMm
	volumeCm3 := volumeMm3 / 1000.0
	return volumeCm3 * densityGCm3
}

// ---------------------------------------------------------------------------
// reportIntent — what the state machine wants to send (no I/O).
// ---------------------------------------------------------------------------

// reportKind discriminates between the two kinds of central report the state
// machine produces.
type reportKind int

const (
	reportKindStatusEvent reportKind = iota
	reportKindCompleted
	reportKindFailed
)

// reportIntent is a pure-value description of one central report to send.
// The read-loop converts these to actual central.StatusReport calls.
type reportIntent struct {
	kind reportKind

	// status-event fields
	eventKind    statusEventKind
	remoteJobRef string
	progressPct  *float64
	errorCode    string
	errorMessage string
	rawPayload   any
	occurredAt   time.Time

	// completed fields (also filled for status-event when kind=completed)
	measuredGrams float64

	// failed fields
	reason  string
	details string
}

// ---------------------------------------------------------------------------
// stateMachine — pure, no network, no I/O
// ---------------------------------------------------------------------------

// stateMachine tracks per-subscription state and maps incoming frames to
// reportIntents.  It is not safe for concurrent use.
type stateMachine struct {
	latestFilamentUsedMm *float64
	density              float64 // g/cm³
	diameter             float64 // mm
}

func newStateMachine(density, diameter float64) *stateMachine {
	return &stateMachine{
		density:  density,
		diameter: diameter,
	}
}

// handleStatusUpdate processes a parsed notify_status_update frame and returns
// zero or more reportIntents.
func (sm *stateMachine) handleStatusUpdate(payload moonrakerStatusPayload, rawMsg any, now time.Time) []reportIntent {
	// Track filament_used.
	if payload.PrintStats != nil && payload.PrintStats.FilamentUsed != nil {
		v := *payload.PrintStats.FilamentUsed
		sm.latestFilamentUsedMm = &v
	}

	state := ""
	if payload.PrintStats != nil {
		state = payload.PrintStats.State
	}
	if state == "" {
		return nil
	}

	kind, ok := mapPrintStatsState(state)
	if !ok {
		return nil
	}

	// Determine progress.
	var progressPct *float64
	var progressSrc *float64
	if payload.DisplayStatus != nil && payload.DisplayStatus.Progress != nil {
		progressSrc = payload.DisplayStatus.Progress
	} else if payload.VirtualSDCard != nil && payload.VirtualSDCard.Progress != nil {
		progressSrc = payload.VirtualSDCard.Progress
	}
	if progressSrc != nil {
		pct := math.Round(*progressSrc * 100)
		progressPct = &pct
	}

	// Determine filename / remoteJobRef.
	remoteJobRef := ""
	if payload.PrintStats != nil {
		remoteJobRef = payload.PrintStats.Filename
	}

	// Error message for firmware_error kind.
	errorMessage := ""
	if kind == kindFirmwareError && payload.PrintStats != nil && payload.PrintStats.Message != "" {
		errorMessage = payload.PrintStats.Message
	}

	// For terminal kinds from status update, also emit a completed or
	// failed report with measured consumption when we have filament data.
	var intents []reportIntent

	intent := reportIntent{
		kind:         reportKindStatusEvent,
		eventKind:    kind,
		remoteJobRef: remoteJobRef,
		progressPct:  progressPct,
		errorMessage: errorMessage,
		rawPayload:   rawMsg,
		occurredAt:   now,
	}
	intents = append(intents, intent)

	// If this is a terminal state from print_stats (complete/cancelled/error),
	// also emit the terminal report so the orchestrator gets the completion signal.
	//
	// Intentional double-fire: terminal reports are emitted from BOTH
	// notify_status_update (here) AND notify_history_changed (handleHistoryChanged)
	// as belt-and-suspenders — history events can be missed on reconnect.  This is
	// safe because POST /api/v1/dispatch/status is idempotent: a duplicate
	// completed/failed for an already-terminal job returns 200 {ok:true,noop:true}
	// (V2-006a).  Do NOT "fix" the duplicate by guarding with a seen-flag here.
	if kind == kindCompleted {
		var grams float64
		if sm.latestFilamentUsedMm != nil {
			grams = filamentMmToGrams(*sm.latestFilamentUsedMm, sm.diameter, sm.density)
		}
		intents = append(intents, reportIntent{
			kind:          reportKindCompleted,
			measuredGrams: grams,
		})
	} else if kind == kindCancelled {
		intents = append(intents, reportIntent{
			kind:    reportKindFailed,
			reason:  "rejected",
			details: "cancelled",
		})
	} else if kind == kindFirmwareError {
		intents = append(intents, reportIntent{
			kind:    reportKindFailed,
			reason:  "rejected",
			details: errorMessage,
		})
	}

	return intents
}

// handleHistoryChanged processes a parsed notify_history_changed frame and
// returns zero or more reportIntents.
func (sm *stateMachine) handleHistoryChanged(entry moonrakerHistoryEntry, rawMsg any, now time.Time) []reportIntent {
	if entry.Action != "finished" {
		return nil
	}
	job := entry.Job
	if job == nil {
		job = &moonrakerHistoryJob{}
	}

	mapping, ok := mapHistoryStatus(job.Status)
	if !ok {
		return nil
	}

	// Update filament_used from history job if present.
	if job.FilamentUsed != nil {
		v := *job.FilamentUsed
		sm.latestFilamentUsedMm = &v
	}

	isTerminal := mapping.kind == kindCompleted ||
		mapping.kind == kindFirmwareError ||
		mapping.kind == kindCancelled ||
		mapping.kind == kindFailed

	var grams float64
	if isTerminal && sm.latestFilamentUsedMm != nil {
		grams = filamentMmToGrams(*sm.latestFilamentUsedMm, sm.diameter, sm.density)
	}

	progressPct100 := 100.0
	var intents []reportIntent

	switch mapping.kind {
	case kindCompleted:
		// Emit a final status-event with kind=completed + a completed phase report.
		intents = append(intents,
			reportIntent{
				kind:          reportKindStatusEvent,
				eventKind:     kindCompleted,
				remoteJobRef:  job.Filename,
				progressPct:   &progressPct100,
				errorCode:     mapping.errorCode,
				rawPayload:    rawMsg,
				occurredAt:    now,
				measuredGrams: grams,
			},
			reportIntent{
				kind:          reportKindCompleted,
				measuredGrams: grams,
			},
		)

	case kindCancelled:
		intents = append(intents,
			reportIntent{
				kind:         reportKindStatusEvent,
				eventKind:    kindCancelled,
				remoteJobRef: job.Filename,
				rawPayload:   rawMsg,
				occurredAt:   now,
			},
			reportIntent{
				kind:    reportKindFailed,
				reason:  "rejected",
				details: "cancelled",
			},
		)

	case kindFirmwareError:
		details := mapping.errorCode
		if details == "" {
			details = "firmware error"
		}
		intents = append(intents,
			reportIntent{
				kind:         reportKindStatusEvent,
				eventKind:    kindFirmwareError,
				remoteJobRef: job.Filename,
				errorCode:    mapping.errorCode,
				rawPayload:   rawMsg,
				occurredAt:   now,
			},
			reportIntent{
				kind:    reportKindFailed,
				reason:  "rejected",
				details: details,
			},
		)

	default: // kindFailed
		intents = append(intents,
			reportIntent{
				kind:         reportKindStatusEvent,
				eventKind:    kindFailed,
				remoteJobRef: job.Filename,
				rawPayload:   rawMsg,
				occurredAt:   now,
			},
			reportIntent{
				kind:    reportKindFailed,
				reason:  "unknown",
				details: fmt.Sprintf("unexpected terminal status: %s", job.Status),
			},
		)
	}

	return intents
}

// ---------------------------------------------------------------------------
// gorilla wsConn adapter
// ---------------------------------------------------------------------------

// gorillaConn wraps a *websocket.Conn to satisfy the wsConn interface.
type gorillaConn struct {
	conn *websocket.Conn
}

func (g *gorillaConn) ReadMessage() ([]byte, error) {
	_, msg, err := g.conn.ReadMessage()
	return msg, err
}

func (g *gorillaConn) WriteMessage(msg []byte) error {
	return g.conn.WriteMessage(websocket.TextMessage, msg)
}

func (g *gorillaConn) Close() error {
	return g.conn.Close()
}

// ---------------------------------------------------------------------------
// Subscribe — main entry point
// ---------------------------------------------------------------------------

// Subscribe opens a WebSocket to the Moonraker instance described by cfg,
// subscribes to printer object updates, and relays StatusEvents to reporter
// until ctx is cancelled or the connection is dropped (in which case an error
// is returned so the orchestrator can reconnect).
//
// density is the filament density in g/cm³ (default 1.24 for PLA).
// diameter is the filament diameter in mm (default 1.75).
func Subscribe(
	ctx context.Context,
	cfg ConnectionConfig,
	cred *Credential,
	jobID string,
	reporter Reporter,
	density, diameter float64,
	log *slog.Logger,
) error {
	return subscribeWithDialer(ctx, cfg, cred, jobID, reporter, density, diameter, log, nil)
}

// subscribeWithDialer is the internal implementation; dialFn is injectable for
// tests.  When dialFn is nil, the real gorilla dialer is used.
func subscribeWithDialer(
	ctx context.Context,
	cfg ConnectionConfig,
	cred *Credential,
	jobID string,
	reporter Reporter,
	density, diameter float64,
	log *slog.Logger,
	dialFn func(rawURL string, header http.Header) (wsConn, error),
) error {
	if log == nil {
		log = slog.Default()
	}

	// Build WebSocket URL.
	scheme := "ws"
	if cfg.Scheme == "https" {
		scheme = "wss"
	}
	rawURL := fmt.Sprintf("%s://%s:%d/websocket", scheme, cfg.Host, cfg.Port)

	// Build headers.
	header := http.Header{}
	if cfg.RequiresAuth && cred != nil && cred.APIKey != "" {
		header.Set("X-Api-Key", cred.APIKey)
	}

	// Dial.
	var conn wsConn
	if dialFn != nil {
		var err error
		conn, err = dialFn(rawURL, header)
		if err != nil {
			return fmt.Errorf("moonraker status: dial %s: %w", rawURL, err)
		}
	} else {
		dialer := websocket.Dialer{
			HandshakeTimeout: 10 * time.Second,
		}
		wsConn, _, err := dialer.DialContext(ctx, rawURL, header)
		if err != nil {
			return fmt.Errorf("moonraker status: dial %s: %w", rawURL, err)
		}
		conn = &gorillaConn{conn: wsConn}
	}
	defer conn.Close()

	// Send the subscribe message.
	if err := conn.WriteMessage(subscribeMessage); err != nil {
		return fmt.Errorf("moonraker status: send subscribe: %w", err)
	}
	log.Info("moonraker status: subscribed", "url", rawURL, "jobID", jobID)

	sm := newStateMachine(density, diameter)

	// Read loop.
	// frameCh is large enough to buffer a burst of frames before the main loop
	// picks them up; this prevents the read goroutine from blocking while the
	// main loop is sending reports.
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

	for {
		// Drain frameCh before checking readErr so that all buffered frames are
		// processed even when the read goroutine has already signalled EOF.
		select {
		case raw := <-frameCh:
			intents := processFrame(sm, raw, log)
			for _, intent := range intents {
				if err := sendIntent(ctx, reporter, jobID, intent, log); err != nil {
					log.Warn("moonraker status: report failed", "err", err, "jobID", jobID)
				}
			}
			continue
		default:
		}

		select {
		case <-ctx.Done():
			log.Info("moonraker status: context cancelled, stopping", "jobID", jobID)
			return ctx.Err()

		case err := <-readErr:
			// Drain any remaining buffered frames before returning.
			for {
				select {
				case raw := <-frameCh:
					intents := processFrame(sm, raw, log)
					for _, intent := range intents {
						if sendErr := sendIntent(ctx, reporter, jobID, intent, log); sendErr != nil {
							log.Warn("moonraker status: report failed", "err", sendErr, "jobID", jobID)
						}
					}
				default:
					return fmt.Errorf("moonraker status: read: %w", err)
				}
			}

		case raw := <-frameCh:
			intents := processFrame(sm, raw, log)
			for _, intent := range intents {
				if err := sendIntent(ctx, reporter, jobID, intent, log); err != nil {
					log.Warn("moonraker status: report failed", "err", err, "jobID", jobID)
				}
			}
		}
	}
}

// processFrame parses one raw WebSocket message and routes it through the
// state machine.  It returns the list of reportIntents to send.
func processFrame(sm *stateMachine, raw []byte, log *slog.Logger) []reportIntent {
	var frame moonrakerFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		log.Warn("moonraker status: unparse-able frame", "err", err)
		return nil
	}

	// Decode params[0] as generic any for rawPayload.
	var rawParamsSlice []json.RawMessage
	_ = json.Unmarshal(frame.Params, &rawParamsSlice)

	var rawPayloadAny any
	if len(rawParamsSlice) > 0 {
		_ = json.Unmarshal(rawParamsSlice[0], &rawPayloadAny)
	}

	now := time.Now()

	switch frame.Method {
	case "notify_status_update":
		if len(rawParamsSlice) == 0 {
			return nil
		}
		var payload moonrakerStatusPayload
		if err := json.Unmarshal(rawParamsSlice[0], &payload); err != nil {
			log.Warn("moonraker status: parse notify_status_update", "err", err)
			return nil
		}
		return sm.handleStatusUpdate(payload, rawPayloadAny, now)

	case "notify_history_changed":
		if len(rawParamsSlice) == 0 {
			return nil
		}
		var entry moonrakerHistoryEntry
		if err := json.Unmarshal(rawParamsSlice[0], &entry); err != nil {
			log.Warn("moonraker status: parse notify_history_changed", "err", err)
			return nil
		}
		return sm.handleHistoryChanged(entry, rawPayloadAny, now)

	default:
		// Subscribe-reply (id=1) or unknown — ignore.
		return nil
	}
}

// sendIntent converts a reportIntent to a central.StatusReport and calls
// reporter.ReportStatus.
func sendIntent(ctx context.Context, reporter Reporter, jobID string, intent reportIntent, log *slog.Logger) error {
	var report central.StatusReport

	switch intent.kind {
	case reportKindStatusEvent:
		evt := central.StatusEventPayload{
			Kind:         string(intent.eventKind),
			RemoteJobRef: intent.remoteJobRef,
			RawPayload:   intent.rawPayload,
			OccurredAt:   intent.occurredAt.UTC().Format(time.RFC3339),
		}
		if intent.progressPct != nil {
			pct := *intent.progressPct
			evt.ProgressPct = &pct
		}
		if intent.errorCode != "" {
			evt.ErrorCode = intent.errorCode
		}
		if intent.errorMessage != "" {
			evt.ErrorMessage = intent.errorMessage
		}
		if intent.measuredGrams > 0 {
			grams := intent.measuredGrams
			evt.MeasuredConsumption = []central.MeasuredConsumptionSlot{
				{SlotIndex: 0, Grams: grams},
			}
		}
		report = central.StatusEventReport(jobID, evt)

	case reportKindCompleted:
		var materials []central.MaterialsUsedSlot
		if intent.measuredGrams > 0 {
			materials = []central.MaterialsUsedSlot{
				{SlotIndex: 0, MaterialID: "", MeasuredGrams: intent.measuredGrams},
			}
		}
		report = central.CompletedReport(jobID, materials)

	case reportKindFailed:
		report = central.FailedReport(jobID, intent.reason, intent.details)

	default:
		log.Warn("moonraker status: unknown reportKind", "kind", intent.kind)
		return nil
	}

	return reporter.ReportStatus(ctx, report)
}
