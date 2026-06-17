package octoprint

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
	"github.com/gorilla/websocket"
)

// ---------------------------------------------------------------------------
// wsConn — thin interface over gorilla websocket.Conn for test injection.
// ---------------------------------------------------------------------------

// wsConn abstracts a WebSocket connection so tests can inject a fake.
type wsConn interface {
	ReadMessage() ([]byte, error)
	WriteMessage([]byte) error
	Close() error
}

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
// SockJS framing
// ---------------------------------------------------------------------------

// sockJsFrameType discriminates SockJS frame prefixes.
type sockJsFrameType int

const (
	sockJsOpen      sockJsFrameType = iota // 'o'
	sockJsHeartbeat                        // 'h'
	sockJsArray                            // 'a[...]'
	sockJsClose                            // 'c[...]'
	sockJsUnknown                          // anything else — treated as empty array
)

// parseSockJsFrame parses a SockJS-framed text message.  It returns the frame
// type and, for array frames, the slice of inner JSON-encoded message strings.
// Malformed payloads produce sockJsUnknown / empty messages slice.
func parseSockJsFrame(raw string) (sockJsFrameType, []string) {
	if raw == "o" {
		return sockJsOpen, nil
	}
	if raw == "h" {
		return sockJsHeartbeat, nil
	}
	if len(raw) == 0 {
		return sockJsUnknown, nil
	}
	switch raw[0] {
	case 'c':
		return sockJsClose, nil
	case 'a':
		var msgs []string
		if err := json.Unmarshal([]byte(raw[1:]), &msgs); err != nil {
			return sockJsArray, nil
		}
		return sockJsArray, msgs
	default:
		return sockJsUnknown, nil
	}
}

// ---------------------------------------------------------------------------
// OctoPrint inner message shapes
// ---------------------------------------------------------------------------

type octoprintCurrentPayload struct {
	State *struct {
		Text string `json:"text"`
	} `json:"state"`
	Progress *struct {
		Completion    *float64 `json:"completion"`
		PrintTimeLeft *float64 `json:"printTimeLeft"`
	} `json:"progress"`
	Job *struct {
		File *struct {
			Name string `json:"name"`
		} `json:"file"`
	} `json:"job"`
}

type octoprintEventPayload struct {
	Type    string `json:"type"`
	Payload *struct {
		Name    string `json:"name"`
		Path    string `json:"path"`
		Reason  string `json:"reason"`
		Message string `json:"message"`
		Error   string `json:"error"`
	} `json:"payload"`
}

type octoprintPluginPayload struct {
	Plugin string `json:"plugin"`
	Data   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"data"`
}

type octoprintInnerMessage struct {
	Current *octoprintCurrentPayload `json:"current"`
	History *octoprintCurrentPayload `json:"history"`
	Event   *octoprintEventPayload   `json:"event"`
	Plugin  *octoprintPluginPayload  `json:"plugin"`
}

// pluginWarningAllowlist lists the OctoPrint plugin identifiers whose messages
// are mapped to warning StatusEvents.  Unknown plugins are silently dropped.
var pluginWarningAllowlist = map[string]bool{
	"OctoPrint-Spool Manager": true,
}

// ---------------------------------------------------------------------------
// State mapping (pure — no I/O, fully testable)
// ---------------------------------------------------------------------------

// statusEventKind mirrors the set of kinds the central API accepts.
type statusEventKind string

const (
	kindProgress      statusEventKind = "progress"
	kindPaused        statusEventKind = "paused"
	kindStarted       statusEventKind = "started"
	kindCompleted     statusEventKind = "completed"
	kindCancelled     statusEventKind = "cancelled"
	kindFirmwareError statusEventKind = "firmware_error"
	kindFailed        statusEventKind = "failed"
	kindWarning       statusEventKind = "warning"
	kindResumed       statusEventKind = "resumed"
)

// mapCurrentState maps an OctoPrint current.state.text to a statusEventKind.
// Returns ("", false) for states we deliberately suppress.
func mapCurrentState(state string) (statusEventKind, bool) {
	switch state {
	case "Printing", "Printing from SD":
		return kindProgress, true
	case "Paused", "Pausing":
		return kindPaused, true
	default:
		return "", false
	}
}

// mapEventType maps an OctoPrint event.type (and optional reason) to a
// statusEventKind. Returns ("", false) for unknown/ignored types.
func mapEventType(evtType, reason string) (statusEventKind, bool) {
	switch evtType {
	case "PrintStarted":
		return kindStarted, true
	case "PrintDone":
		return kindCompleted, true
	case "PrintCancelled":
		return kindCancelled, true
	case "PrintFailed":
		if reason == "cancelled" {
			return kindCancelled, true
		}
		if reason == "error" {
			return kindFirmwareError, true
		}
		return kindFailed, true
	case "Error":
		return kindFirmwareError, true
	case "PrintPaused":
		return kindPaused, true
	case "PrintResumed":
		return kindResumed, true
	default:
		return "", false
	}
}

// ---------------------------------------------------------------------------
// reportIntent — what the state machine wants to send (no I/O).
// ---------------------------------------------------------------------------

type reportKind int

const (
	reportKindStatusEvent reportKind = iota
	reportKindCompleted
	reportKindFailed
)

type reportIntent struct {
	kind reportKind

	// status-event fields
	eventKind    statusEventKind
	remoteJobRef string
	progressPct  *float64
	remainingMin *float64
	errorCode    string
	errorMessage string
	severity     string
	rawPayload   any
	occurredAt   time.Time

	// failed fields
	reason  string
	details string
}

// ---------------------------------------------------------------------------
// stateMachine — pure, no network, no I/O
// ---------------------------------------------------------------------------

// stateMachine routes incoming SockJS inner messages to reportIntents.
// OctoPrint does not report measured consumption, so completed events carry
// no materials_used — the server's Phase-A slicer estimate stands.
type stateMachine struct{}

// handleCurrent processes an OctoPrint current (or history) payload.
func (sm *stateMachine) handleCurrent(payload *octoprintCurrentPayload, rawMsg any, now time.Time) []reportIntent {
	if payload == nil {
		return nil
	}
	stateText := ""
	if payload.State != nil {
		stateText = payload.State.Text
	}
	kind, ok := mapCurrentState(stateText)
	if !ok {
		return nil
	}

	var progressPct *float64
	var remainingMin *float64
	if payload.Progress != nil {
		if payload.Progress.Completion != nil && isFinite(*payload.Progress.Completion) {
			pct := math.Round(*payload.Progress.Completion)
			progressPct = &pct
		}
		if payload.Progress.PrintTimeLeft != nil && isFinite(*payload.Progress.PrintTimeLeft) {
			rm := math.Round(*payload.Progress.PrintTimeLeft / 60.0)
			remainingMin = &rm
		}
	}

	remoteJobRef := ""
	if payload.Job != nil && payload.Job.File != nil {
		remoteJobRef = payload.Job.File.Name
	}

	return []reportIntent{{
		kind:         reportKindStatusEvent,
		eventKind:    kind,
		remoteJobRef: remoteJobRef,
		progressPct:  progressPct,
		remainingMin: remainingMin,
		rawPayload:   rawMsg,
		occurredAt:   now,
	}}
}

// handleEvent processes an OctoPrint event message.
func (sm *stateMachine) handleEvent(evt *octoprintEventPayload, rawMsg any, now time.Time) []reportIntent {
	if evt == nil {
		return nil
	}
	reason := ""
	if evt.Payload != nil {
		reason = evt.Payload.Reason
	}
	kind, ok := mapEventType(evt.Type, reason)
	if !ok {
		return nil
	}

	remoteJobRef := ""
	if evt.Payload != nil {
		if evt.Payload.Name != "" {
			remoteJobRef = evt.Payload.Name
		} else if evt.Payload.Path != "" {
			remoteJobRef = evt.Payload.Path
		}
	}

	intent := reportIntent{
		kind:         reportKindStatusEvent,
		eventKind:    kind,
		remoteJobRef: remoteJobRef,
		rawPayload:   rawMsg,
		occurredAt:   now,
	}

	if kind == kindCompleted {
		intent.progressPct = ptrFloat64(100.0)
	}

	// Attach error details for firmware_error / failed.
	if evt.Type == "Error" && evt.Payload != nil {
		if evt.Payload.Reason != "" {
			intent.errorCode = evt.Payload.Reason
		}
		if evt.Payload.Error != "" {
			intent.errorMessage = evt.Payload.Error
		}
	} else if kind == kindFirmwareError && evt.Payload != nil && evt.Payload.Message != "" {
		intent.errorMessage = evt.Payload.Message
	}

	var intents []reportIntent
	intents = append(intents, intent)

	// Terminal kinds also produce a phase report.
	switch kind {
	case kindCompleted:
		// OctoPrint does not report measured consumption — no materials_used.
		intents = append(intents, reportIntent{
			kind: reportKindCompleted,
		})
	case kindCancelled:
		intents = append(intents, reportIntent{
			kind:    reportKindFailed,
			reason:  "rejected",
			details: "cancelled",
		})
	case kindFirmwareError, kindFailed:
		details := intent.errorMessage
		if details == "" {
			details = string(kind)
		}
		intents = append(intents, reportIntent{
			kind:    reportKindFailed,
			reason:  "rejected",
			details: details,
		})
	}

	return intents
}

// handlePlugin processes an OctoPrint plugin message.
func (sm *stateMachine) handlePlugin(plug *octoprintPluginPayload, rawMsg any, now time.Time) []reportIntent {
	if plug == nil {
		return nil
	}
	if !pluginWarningAllowlist[plug.Plugin] {
		return nil
	}
	code := "warning"
	if plug.Data != nil && plug.Data.Code != "" {
		code = plug.Data.Code
	}
	errCode := plug.Plugin + "/" + code
	errMsg := ""
	if plug.Data != nil {
		errMsg = plug.Data.Message
	}
	return []reportIntent{{
		kind:         reportKindStatusEvent,
		eventKind:    kindWarning,
		remoteJobRef: "",
		errorCode:    errCode,
		errorMessage: errMsg,
		severity:     "warning",
		rawPayload:   rawMsg,
		occurredAt:   now,
	}}
}

// processInnerMessage routes a decoded inner message through the state machine.
func processInnerMessage(sm *stateMachine, inner *octoprintInnerMessage, rawMsg any, now time.Time) []reportIntent {
	if inner == nil {
		return nil
	}
	if inner.Current != nil {
		return sm.handleCurrent(inner.Current, rawMsg, now)
	}
	if inner.History != nil {
		return sm.handleCurrent(inner.History, rawMsg, now)
	}
	if inner.Event != nil {
		return sm.handleEvent(inner.Event, rawMsg, now)
	}
	if inner.Plugin != nil {
		return sm.handlePlugin(inner.Plugin, rawMsg, now)
	}
	return nil
}

// decodeInnerMessage parses a JSON-encoded inner message string.
func decodeInnerMessage(jsonStr string) (*octoprintInnerMessage, any) {
	var inner octoprintInnerMessage
	if err := json.Unmarshal([]byte(jsonStr), &inner); err != nil {
		return nil, nil
	}
	var rawAny any
	_ = json.Unmarshal([]byte(jsonStr), &rawAny)
	return &inner, rawAny
}

// ---------------------------------------------------------------------------
// Login (HTTP)
// ---------------------------------------------------------------------------

type loginReply struct {
	Name    string `json:"name"`
	Session string `json:"session"`
}

func performLogin(ctx context.Context, httpClient *http.Client, loginURL, apiKey string) (loginReply, error) {
	body := []byte(`{"passive":true}`)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, loginURL, bytes.NewReader(body))
	if err != nil {
		return loginReply{}, fmt.Errorf("octoprint login: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)

	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return loginReply{}, fmt.Errorf("octoprint login: request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return loginReply{}, fmt.Errorf("octoprint login: HTTP %d", resp.StatusCode)
	}
	var reply loginReply
	if err := json.NewDecoder(resp.Body).Decode(&reply); err != nil {
		return loginReply{}, fmt.Errorf("octoprint login: decode response: %w", err)
	}
	return reply, nil
}

// ---------------------------------------------------------------------------
// Subscribe — main entry point
// ---------------------------------------------------------------------------

// Subscribe opens a SockJS WebSocket to the OctoPrint instance described by
// cfg, authenticates if required, and relays StatusEvents to reporter until
// ctx is cancelled or the connection drops (returning an error so the
// orchestrator can reconnect).
//
// "sent ≠ failed": a feed drop MUST NOT fail the job. The caller (orchestrator)
// decides what to do with the returned error.
func Subscribe(
	ctx context.Context,
	cfg ConnectionConfig,
	cred *Credential,
	jobID string,
	reporter printers.Reporter,
	log *slog.Logger,
) error {
	return subscribeWithDialer(ctx, cfg, cred, jobID, reporter, log, nil, nil)
}

// subscribeWithDialer is the internal implementation; dialFn and httpClient are
// injectable for tests. When nil, real defaults are used.
func subscribeWithDialer(
	ctx context.Context,
	cfg ConnectionConfig,
	cred *Credential,
	jobID string,
	reporter printers.Reporter,
	log *slog.Logger,
	dialFn func(rawURL string) (wsConn, error),
	httpClient *http.Client,
) error {
	if log == nil {
		log = slog.Default()
	}

	// Build WebSocket URL — note: drops apiPath, uses /sockjs/websocket.
	wsScheme := "ws"
	if cfg.Scheme == "https" {
		wsScheme = "wss"
	}
	rawURL := fmt.Sprintf("%s://%s:%d/sockjs/websocket", wsScheme, cfg.Host, cfg.Port)

	// Perform HTTP login (if auth required) to get the auth message.
	var authMessage string
	if cfg.RequiresAuth && cred != nil && cred.APIKey != "" {
		loginURL := fmt.Sprintf("%s://%s:%d%s/login", cfg.Scheme, cfg.Host, cfg.Port, cfg.APIPath)
		reply, err := performLogin(ctx, httpClient, loginURL, cred.APIKey)
		if err != nil {
			return fmt.Errorf("octoprint status: login: %w", err)
		}
		if reply.Name != "" && reply.Session != "" {
			authMessage = fmt.Sprintf(`{"auth":"%s:%s"}`, reply.Name, reply.Session)
		} else {
			// Fallback: use raw apiKey
			authMessage = fmt.Sprintf(`{"auth":"%s"}`, cred.APIKey)
		}
	}

	// Dial.
	var conn wsConn
	if dialFn != nil {
		var err error
		conn, err = dialFn(rawURL)
		if err != nil {
			return fmt.Errorf("octoprint status: dial %s: %w", rawURL, err)
		}
	} else {
		dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
		wsConn, _, err := dialer.DialContext(ctx, rawURL, nil)
		if err != nil {
			return fmt.Errorf("octoprint status: dial %s: %w", rawURL, err)
		}
		conn = &gorillaConn{conn: wsConn}
	}
	defer conn.Close()

	log.Info("octoprint status: connected", "url", rawURL, "jobID", jobID)

	sm := &stateMachine{}
	authSent := false
	authed := authMessage == "" // if no auth needed, we're already "authed"

	// Read loop — feeds messages from the read goroutine into the main select.
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

	processFn := func(raw []byte) {
		frameType, msgs := parseSockJsFrame(string(raw))
		switch frameType {
		case sockJsHeartbeat, sockJsClose, sockJsUnknown:
			return
		case sockJsOpen:
			if authMessage != "" && !authSent {
				authSent = true
				if err := conn.WriteMessage([]byte(authMessage)); err != nil {
					log.Warn("octoprint status: auth send failed", "err", err, "jobID", jobID)
				}
			}
			return
		case sockJsArray:
			// First array frame after sending auth means the server accepted it.
			if !authed && authSent {
				authed = true
			}
			now := time.Now()
			for _, msgStr := range msgs {
				inner, rawAny := decodeInnerMessage(msgStr)
				if inner == nil {
					continue
				}
				intents := processInnerMessage(sm, inner, rawAny, now)
				for _, intent := range intents {
					if err := sendIntent(ctx, reporter, jobID, intent, log); err != nil {
						log.Warn("octoprint status: report failed", "err", err, "jobID", jobID)
					}
				}
			}
		}
	}

	for {
		// Drain frameCh before checking readErr.
		select {
		case raw := <-frameCh:
			processFn(raw)
			continue
		default:
		}

		select {
		case <-ctx.Done():
			log.Info("octoprint status: context cancelled, stopping", "jobID", jobID)
			return ctx.Err()

		case err := <-readErr:
			// Drain remaining buffered frames.
			for {
				select {
				case raw := <-frameCh:
					processFn(raw)
				default:
					return fmt.Errorf("octoprint status: read: %w", err)
				}
			}

		case raw := <-frameCh:
			processFn(raw)
		}
	}
}

// sendIntent converts a reportIntent to a central.StatusReport call.
func sendIntent(ctx context.Context, reporter printers.Reporter, jobID string, intent reportIntent, log *slog.Logger) error {
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
		if intent.remainingMin != nil {
			rm := *intent.remainingMin
			evt.RemainingMin = &rm
		}
		if intent.errorCode != "" {
			evt.ErrorCode = intent.errorCode
		}
		if intent.errorMessage != "" {
			evt.ErrorMessage = intent.errorMessage
		}
		if intent.severity != "" {
			evt.Severity = intent.severity
		}
		report = central.StatusEventReport(jobID, evt)

	case reportKindCompleted:
		// OctoPrint does not report measured consumption — no materials_used.
		report = central.CompletedReport(jobID, nil)

	case reportKindFailed:
		report = central.FailedReport(jobID, intent.reason, intent.details)

	default:
		log.Warn("octoprint status: unknown reportKind", "kind", intent.kind)
		return nil
	}

	return reporter.ReportStatus(ctx, report)
}

func ptrFloat64(v float64) *float64 { return &v }

// isFinite returns true when v is neither NaN nor ±Inf.
func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}
