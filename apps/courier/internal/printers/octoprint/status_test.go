// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package octoprint

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// ---------------------------------------------------------------------------
// Spy reporter
// ---------------------------------------------------------------------------

type spyReporter struct {
	mu      sync.Mutex
	reports []central.StatusReport
}

func (s *spyReporter) ReportStatus(_ context.Context, payload central.StatusReport) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reports = append(s.reports, payload)
	return nil
}

func (s *spyReporter) allReports() []central.StatusReport {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]central.StatusReport, len(s.reports))
	copy(cp, s.reports)
	return cp
}

func (s *spyReporter) firstByPhase(phase string) (central.StatusReport, bool) {
	for _, r := range s.allReports() {
		if r.Phase == phase {
			return r, true
		}
	}
	return central.StatusReport{}, false
}

func phasesOf(reports []central.StatusReport) []string {
	phases := make([]string, 0, len(reports))
	for _, r := range reports {
		phases = append(phases, r.Phase)
	}
	return phases
}

// ---------------------------------------------------------------------------
// Fake wsConn
// ---------------------------------------------------------------------------

type fakeConn struct {
	mu      sync.Mutex
	frames  [][]byte
	pos     int
	written [][]byte
	blockCh chan struct{}
}

func newFakeConn(frames ...[]byte) *fakeConn {
	return &fakeConn{frames: frames}
}

func newBlockingFakeConn(frames ...[]byte) *fakeConn {
	return &fakeConn{frames: frames, blockCh: make(chan struct{})}
}

func (f *fakeConn) Unblock() {
	f.mu.Lock()
	ch := f.blockCh
	f.blockCh = nil
	f.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func (f *fakeConn) ReadMessage() ([]byte, error) {
	f.mu.Lock()
	if f.pos < len(f.frames) {
		msg := f.frames[f.pos]
		f.pos++
		f.mu.Unlock()
		return msg, nil
	}
	ch := f.blockCh
	f.mu.Unlock()

	if ch != nil {
		<-ch
		return nil, errors.New("fake conn: closed")
	}
	return nil, errors.New("fake conn: EOF")
}

func (f *fakeConn) WriteMessage(msg []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := make([]byte, len(msg))
	copy(cp, msg)
	f.written = append(f.written, cp)
	return nil
}

func (f *fakeConn) Close() error {
	return nil
}

func (f *fakeConn) Written() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := make([][]byte, len(f.written))
	copy(cp, f.written)
	return cp
}

// ---------------------------------------------------------------------------
// SockJS frame building helpers
// ---------------------------------------------------------------------------

// sockJsArrayFrame wraps inner JSON message strings into a SockJS 'a' frame.
func sockJsArrayFrame(msgs ...string) []byte {
	b, _ := json.Marshal(msgs)
	return []byte("a" + string(b))
}

// innerMsg marshals a Go map to a JSON string (for embedding in a sockjs array).
func innerMsg(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("innerMsg: %v", err)
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Unit tests — parseSockJsFrame
// ---------------------------------------------------------------------------

func TestParseSockJsFrame_Open(t *testing.T) {
	ft, msgs := parseSockJsFrame("o")
	if ft != sockJsOpen {
		t.Errorf("want sockJsOpen, got %v", ft)
	}
	if msgs != nil {
		t.Errorf("want nil msgs for open, got %v", msgs)
	}
}

func TestParseSockJsFrame_Heartbeat(t *testing.T) {
	ft, _ := parseSockJsFrame("h")
	if ft != sockJsHeartbeat {
		t.Errorf("want sockJsHeartbeat, got %v", ft)
	}
}

func TestParseSockJsFrame_Close(t *testing.T) {
	ft, _ := parseSockJsFrame(`c[3000,"Go away!"]`)
	if ft != sockJsClose {
		t.Errorf("want sockJsClose, got %v", ft)
	}
}

func TestParseSockJsFrame_ArrayMessages(t *testing.T) {
	raw := `a["{\"current\":{\"state\":{\"text\":\"Printing\"}}}"]`
	ft, msgs := parseSockJsFrame(raw)
	if ft != sockJsArray {
		t.Errorf("want sockJsArray, got %v", ft)
	}
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d", len(msgs))
	}
}

func TestParseSockJsFrame_EmptyString(t *testing.T) {
	ft, _ := parseSockJsFrame("")
	if ft != sockJsUnknown {
		t.Errorf("want sockJsUnknown for empty, got %v", ft)
	}
}

func TestParseSockJsFrame_MalformedArray(t *testing.T) {
	ft, msgs := parseSockJsFrame("a{not-json}")
	if ft != sockJsArray {
		t.Errorf("want sockJsArray even on malformed, got %v", ft)
	}
	if len(msgs) != 0 {
		t.Errorf("want empty msgs on malformed, got %v", msgs)
	}
}

// ---------------------------------------------------------------------------
// Unit tests — mapCurrentState
// ---------------------------------------------------------------------------

func TestMapCurrentState_Printing(t *testing.T) {
	kind, ok := mapCurrentState("Printing")
	if !ok || kind != kindProgress {
		t.Errorf("Printing: want (progress, true), got (%s, %v)", kind, ok)
	}
}

func TestMapCurrentState_PrintingFromSD(t *testing.T) {
	kind, ok := mapCurrentState("Printing from SD")
	if !ok || kind != kindProgress {
		t.Errorf("Printing from SD: want (progress, true), got (%s, %v)", kind, ok)
	}
}

func TestMapCurrentState_Paused(t *testing.T) {
	kind, ok := mapCurrentState("Paused")
	if !ok || kind != kindPaused {
		t.Errorf("Paused: want (paused, true), got (%s, %v)", kind, ok)
	}
}

func TestMapCurrentState_Pausing(t *testing.T) {
	kind, ok := mapCurrentState("Pausing")
	if !ok || kind != kindPaused {
		t.Errorf("Pausing: want (paused, true), got (%s, %v)", kind, ok)
	}
}

func TestMapCurrentState_Operational_Ignored(t *testing.T) {
	_, ok := mapCurrentState("Operational")
	if ok {
		t.Errorf("Operational: want (_, false), got ok=true")
	}
}

func TestMapCurrentState_Empty_Ignored(t *testing.T) {
	_, ok := mapCurrentState("")
	if ok {
		t.Errorf("empty: want (_, false), got ok=true")
	}
}

// ---------------------------------------------------------------------------
// Unit tests — mapEventType
// ---------------------------------------------------------------------------

func TestMapEventType_PrintDone(t *testing.T) {
	kind, ok := mapEventType("PrintDone", "")
	if !ok || kind != kindCompleted {
		t.Errorf("PrintDone: want (completed, true), got (%s, %v)", kind, ok)
	}
}

func TestMapEventType_PrintCancelled(t *testing.T) {
	kind, ok := mapEventType("PrintCancelled", "")
	if !ok || kind != kindCancelled {
		t.Errorf("PrintCancelled: want (cancelled, true), got (%s, %v)", kind, ok)
	}
}

func TestMapEventType_PrintFailed_ReasonCancelled(t *testing.T) {
	kind, ok := mapEventType("PrintFailed", "cancelled")
	if !ok || kind != kindCancelled {
		t.Errorf("PrintFailed/cancelled: want (cancelled, true), got (%s, %v)", kind, ok)
	}
}

func TestMapEventType_PrintFailed_ReasonError(t *testing.T) {
	kind, ok := mapEventType("PrintFailed", "error")
	if !ok || kind != kindFirmwareError {
		t.Errorf("PrintFailed/error: want (firmware_error, true), got (%s, %v)", kind, ok)
	}
}

func TestMapEventType_PrintFailed_NoReason(t *testing.T) {
	kind, ok := mapEventType("PrintFailed", "")
	if !ok || kind != kindFailed {
		t.Errorf("PrintFailed/noReason: want (failed, true), got (%s, %v)", kind, ok)
	}
}

func TestMapEventType_Error(t *testing.T) {
	kind, ok := mapEventType("Error", "")
	if !ok || kind != kindFirmwareError {
		t.Errorf("Error: want (firmware_error, true), got (%s, %v)", kind, ok)
	}
}

func TestMapEventType_Unknown_Ignored(t *testing.T) {
	_, ok := mapEventType("SomethingRandom", "")
	if ok {
		t.Errorf("unknown event: want (_, false), got ok=true")
	}
}

// ---------------------------------------------------------------------------
// Unit tests — stateMachine.handleCurrent
// ---------------------------------------------------------------------------

func TestHandleCurrent_Printing_Progress(t *testing.T) {
	sm := &stateMachine{}
	completion := 42.5
	timeLeft := 3600.0
	payload := &octoprintCurrentPayload{
		State: &struct {
			Text string `json:"text"`
		}{Text: "Printing"},
		Progress: &struct {
			Completion    *float64 `json:"completion"`
			PrintTimeLeft *float64 `json:"printTimeLeft"`
		}{Completion: &completion, PrintTimeLeft: &timeLeft},
		Job: &struct {
			File *struct {
				Name string `json:"name"`
			} `json:"file"`
		}{File: &struct {
			Name string `json:"name"`
		}{Name: "benchy.gcode"}},
	}

	intents := sm.handleCurrent(payload, nil, time.Now())
	if len(intents) != 1 {
		t.Fatalf("want 1 intent, got %d", len(intents))
	}
	got := intents[0]
	if got.eventKind != kindProgress {
		t.Errorf("want kindProgress, got %s", got.eventKind)
	}
	if got.remoteJobRef != "benchy.gcode" {
		t.Errorf("remoteJobRef: got %q, want \"benchy.gcode\"", got.remoteJobRef)
	}
	if got.progressPct == nil || *got.progressPct != 43 {
		t.Errorf("progressPct: want 43, got %v", got.progressPct)
	}
	if got.remainingMin == nil || *got.remainingMin != 60 {
		t.Errorf("remainingMin: want 60, got %v", got.remainingMin)
	}
}

func TestHandleCurrent_Operational_Ignored(t *testing.T) {
	sm := &stateMachine{}
	payload := &octoprintCurrentPayload{
		State: &struct {
			Text string `json:"text"`
		}{Text: "Operational"},
	}
	intents := sm.handleCurrent(payload, nil, time.Now())
	if len(intents) != 0 {
		t.Errorf("Operational should produce no intents, got %d", len(intents))
	}
}

func TestHandleCurrent_Nil_NoIntents(t *testing.T) {
	sm := &stateMachine{}
	intents := sm.handleCurrent(nil, nil, time.Now())
	if len(intents) != 0 {
		t.Errorf("nil payload should produce no intents, got %d", len(intents))
	}
}

// ---------------------------------------------------------------------------
// Unit tests — stateMachine.handleEvent
// ---------------------------------------------------------------------------

func TestHandleEvent_PrintDone_CompletedPhaseReport(t *testing.T) {
	sm := &stateMachine{}
	evt := &octoprintEventPayload{
		Type: "PrintDone",
		Payload: &struct {
			Name    string `json:"name"`
			Path    string `json:"path"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
			Error   string `json:"error"`
		}{Name: "cube.gcode"},
	}

	intents := sm.handleEvent(evt, nil, time.Now())
	if len(intents) != 2 {
		t.Fatalf("want 2 intents for PrintDone, got %d", len(intents))
	}
	if intents[0].eventKind != kindCompleted {
		t.Errorf("want kindCompleted, got %s", intents[0].eventKind)
	}
	if intents[0].progressPct == nil || *intents[0].progressPct != 100 {
		t.Errorf("want progressPct=100, got %v", intents[0].progressPct)
	}
	if intents[1].kind != reportKindCompleted {
		t.Errorf("second intent: want reportKindCompleted, got %v", intents[1].kind)
	}
	// OctoPrint: no materials_used — this is intentional.
}

func TestHandleEvent_PrintFailed_Cancelled_FailedPhaseReport(t *testing.T) {
	sm := &stateMachine{}
	evt := &octoprintEventPayload{
		Type: "PrintFailed",
		Payload: &struct {
			Name    string `json:"name"`
			Path    string `json:"path"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
			Error   string `json:"error"`
		}{Reason: "cancelled"},
	}

	intents := sm.handleEvent(evt, nil, time.Now())
	if len(intents) != 2 {
		t.Fatalf("want 2 intents, got %d", len(intents))
	}
	if intents[0].eventKind != kindCancelled {
		t.Errorf("want kindCancelled, got %s", intents[0].eventKind)
	}
	if intents[1].reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", intents[1].reason)
	}
}

func TestHandleEvent_PrintFailed_Error_FirmwareError(t *testing.T) {
	sm := &stateMachine{}
	evt := &octoprintEventPayload{
		Type: "PrintFailed",
		Payload: &struct {
			Name    string `json:"name"`
			Path    string `json:"path"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
			Error   string `json:"error"`
		}{Reason: "error", Message: "thermal runaway"},
	}

	intents := sm.handleEvent(evt, nil, time.Now())
	if len(intents) != 2 {
		t.Fatalf("want 2 intents, got %d", len(intents))
	}
	if intents[0].eventKind != kindFirmwareError {
		t.Errorf("want kindFirmwareError, got %s", intents[0].eventKind)
	}
	if intents[0].errorMessage != "thermal runaway" {
		t.Errorf("errorMessage: got %q, want \"thermal runaway\"", intents[0].errorMessage)
	}
}

func TestHandleEvent_Error_FirmwareError_WithCode(t *testing.T) {
	sm := &stateMachine{}
	evt := &octoprintEventPayload{
		Type: "Error",
		Payload: &struct {
			Name    string `json:"name"`
			Path    string `json:"path"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
			Error   string `json:"error"`
		}{Reason: "firmware_error", Error: "Thermal runaway triggered"},
	}

	intents := sm.handleEvent(evt, nil, time.Now())
	if len(intents) != 2 {
		t.Fatalf("want 2 intents, got %d", len(intents))
	}
	if intents[0].eventKind != kindFirmwareError {
		t.Errorf("want kindFirmwareError, got %s", intents[0].eventKind)
	}
	if intents[0].errorCode != "firmware_error" {
		t.Errorf("errorCode: got %q, want \"firmware_error\"", intents[0].errorCode)
	}
	if intents[0].errorMessage != "Thermal runaway triggered" {
		t.Errorf("errorMessage: got %q", intents[0].errorMessage)
	}
}

// ---------------------------------------------------------------------------
// Unit tests — stateMachine.handlePlugin
// ---------------------------------------------------------------------------

func TestHandlePlugin_AllowlistedPlugin_WarningEvent(t *testing.T) {
	sm := &stateMachine{}
	plug := &octoprintPluginPayload{
		Plugin: "OctoPrint-Spool Manager",
		Data: &struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{Code: "filament_low", Message: "Spool running low"},
	}

	intents := sm.handlePlugin(plug, nil, time.Now())
	if len(intents) != 1 {
		t.Fatalf("want 1 intent, got %d", len(intents))
	}
	got := intents[0]
	if got.eventKind != kindWarning {
		t.Errorf("want kindWarning, got %s", got.eventKind)
	}
	if got.errorCode != "OctoPrint-Spool Manager/filament_low" {
		t.Errorf("errorCode: got %q", got.errorCode)
	}
	if got.errorMessage != "Spool running low" {
		t.Errorf("errorMessage: got %q", got.errorMessage)
	}
	if got.severity != "warning" {
		t.Errorf("severity: got %q, want \"warning\"", got.severity)
	}
}

func TestHandlePlugin_UnknownPlugin_Ignored(t *testing.T) {
	sm := &stateMachine{}
	plug := &octoprintPluginPayload{
		Plugin: "SomeRandomPlugin",
		Data: &struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{Code: "foo"},
	}
	intents := sm.handlePlugin(plug, nil, time.Now())
	if len(intents) != 0 {
		t.Errorf("unknown plugin should be ignored, got %d intents", len(intents))
	}
}

func TestHandlePlugin_NilPlugin_NoIntents(t *testing.T) {
	sm := &stateMachine{}
	intents := sm.handlePlugin(nil, nil, time.Now())
	if len(intents) != 0 {
		t.Errorf("nil plugin should produce no intents, got %d", len(intents))
	}
}

// ---------------------------------------------------------------------------
// Subscribe — URL construction + WS scheme (ws vs wss)
// ---------------------------------------------------------------------------

func TestSubscribe_WSSForHTTPS(t *testing.T) {
	var capturedURL string

	dialFn := func(rawURL string) (wsConn, error) {
		capturedURL = rawURL
		conn := newFakeConn([]byte("o"), []byte(`a["{}"]`))
		return conn, nil
	}

	cfg := ConnectionConfig{
		Host:         "octoprint.local",
		Port:         80,
		Scheme:       "https",
		APIPath:      "/api",
		RequiresAuth: false,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "job1", spy, nil, dialFn, nil)

	if capturedURL != "wss://octoprint.local:80/sockjs/websocket" {
		t.Errorf("want wss URL, got %s", capturedURL)
	}
}

func TestSubscribe_WSForHTTP(t *testing.T) {
	var capturedURL string

	dialFn := func(rawURL string) (wsConn, error) {
		capturedURL = rawURL
		conn := newFakeConn([]byte("o"), []byte(`a["{}"]`))
		return conn, nil
	}

	cfg := ConnectionConfig{
		Host:         "192.168.1.100",
		Port:         5000,
		Scheme:       "http",
		APIPath:      "/api",
		RequiresAuth: false,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "job1", spy, nil, dialFn, nil)

	if capturedURL != "ws://192.168.1.100:5000/sockjs/websocket" {
		t.Errorf("want ws URL, got %s", capturedURL)
	}
}

func TestSubscribe_SockJSPath_DropsAPIPath(t *testing.T) {
	// Confirms the WS URL uses /sockjs/websocket, NOT /api/sockjs/websocket
	var capturedURL string

	dialFn := func(rawURL string) (wsConn, error) {
		capturedURL = rawURL
		conn := newFakeConn([]byte("o"), []byte(`a["{}"]`))
		return conn, nil
	}

	cfg := ConnectionConfig{
		Host:         "printer.local",
		Port:         80,
		Scheme:       "http",
		APIPath:      "/octoprint/api", // custom path — must NOT appear in WS URL
		RequiresAuth: false,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "job1", spy, nil, dialFn, nil)

	if capturedURL != "ws://printer.local:80/sockjs/websocket" {
		t.Errorf("sockjs WS URL: got %q, want \"ws://printer.local:80/sockjs/websocket\"", capturedURL)
	}
}

// ---------------------------------------------------------------------------
// Subscribe — login handshake
// ---------------------------------------------------------------------------

func TestSubscribe_LoginHandshake_AuthMessageSent(t *testing.T) {
	// Stand up a fake /api/login endpoint.
	loginSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/login" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("X-Api-Key") != "my-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"name":"testuser","session":"sess123"}`)
	}))
	defer loginSrv.Close()

	var authMsgSent string

	dialFn := func(rawURL string) (wsConn, error) {
		conn := &captureWriteConn{inner: newBlockingFakeConn([]byte("o"), []byte(`a["{}"]`))}
		return conn, nil
	}

	// We need to capture the written auth message from the WS conn.
	var capturedWriteConn *captureWriteConn
	dialFn = func(rawURL string) (wsConn, error) {
		capturedWriteConn = &captureWriteConn{inner: newFakeConn([]byte("o"), []byte(`a["{}"]`))}
		return capturedWriteConn, nil
	}
	_ = authMsgSent

	// Extract login server host/port.
	loginHost, loginPort := hostPort(t, loginSrv.URL)

	cfg := ConnectionConfig{
		Host:         loginHost,
		Port:         loginPort,
		Scheme:       "http",
		APIPath:      "/api",
		RequiresAuth: true,
	}
	cred := &Credential{APIKey: "my-key"}

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, cred, "jobLogin", spy, nil, dialFn, nil)

	// The first written message must be the auth message.
	written := capturedWriteConn.Written()
	if len(written) == 0 {
		t.Fatal("expected auth message to be written to the WS, got none")
	}
	var authMsg map[string]string
	if err := json.Unmarshal(written[0], &authMsg); err != nil {
		t.Fatalf("auth message is not valid JSON: %v", err)
	}
	if authMsg["auth"] != "testuser:sess123" {
		t.Errorf("auth message: got %q, want \"testuser:sess123\"", authMsg["auth"])
	}
}

func TestSubscribe_NoAuth_NoLoginCall(t *testing.T) {
	// If we get called, the test fails.
	loginSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("login endpoint should NOT be called when requiresAuth=false")
	}))
	defer loginSrv.Close()

	loginHost, loginPort := hostPort(t, loginSrv.URL)

	var authWritten bool
	dialFn := func(rawURL string) (wsConn, error) {
		conn := newFakeConn([]byte("o"), []byte(`a["{}"]`))
		return &captureWriteFlagConn{inner: conn, flag: &authWritten}, nil
	}

	cfg := ConnectionConfig{
		Host:         loginHost,
		Port:         loginPort,
		Scheme:       "http",
		APIPath:      "/api",
		RequiresAuth: false,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobNoAuth", spy, nil, dialFn, nil)

	if authWritten {
		t.Error("auth message was written when requiresAuth=false")
	}
}

// ---------------------------------------------------------------------------
// Subscribe — context cancel and read error
// ---------------------------------------------------------------------------

func TestSubscribe_CtxCancel_CleanReturn(t *testing.T) {
	blocking := newBlockingFakeConn()

	dialFn := func(rawURL string) (wsConn, error) {
		return blocking, nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 80, Scheme: "http", APIPath: "/api", RequiresAuth: false}
	ctx, cancel := context.WithCancel(context.Background())

	errCh := make(chan error, 1)
	go func() {
		spy := &spyReporter{}
		errCh <- subscribeWithDialer(ctx, cfg, nil, "job1", spy, nil, dialFn, nil)
	}()

	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("want context.Canceled, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Subscribe did not return after ctx cancel")
	}
}

func TestSubscribe_ReadError_ReturnsError(t *testing.T) {
	dialFn := func(rawURL string) (wsConn, error) {
		return newFakeConn(), nil // no frames → immediate EOF
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 80, Scheme: "http", APIPath: "/api", RequiresAuth: false}
	spy := &spyReporter{}
	err := subscribeWithDialer(context.Background(), cfg, nil, "job1", spy, nil, dialFn, nil)
	if err == nil {
		t.Error("expected error on read EOF, got nil")
	}
}

// ---------------------------------------------------------------------------
// Subscribe — end-to-end frame routing → reporter
// ---------------------------------------------------------------------------

func TestSubscribe_Printing_ProgressReport(t *testing.T) {
	completion := 65.0
	timeLeft := 1200.0
	msg := innerMsg(t, map[string]any{
		"current": map[string]any{
			"state":    map[string]any{"text": "Printing"},
			"progress": map[string]any{"completion": completion, "printTimeLeft": timeLeft},
			"job":      map[string]any{"file": map[string]any{"name": "cube.gcode"}},
		},
	})
	frame := sockJsArrayFrame(msg)

	dialFn := func(rawURL string) (wsConn, error) {
		return newFakeConn([]byte("o"), frame), nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 80, Scheme: "http", APIPath: "/api", RequiresAuth: false}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobProgress", spy, nil, dialFn, nil)

	reports := spy.allReports()
	var statusEvent *central.StatusReport
	for i := range reports {
		if reports[i].Phase == "status-event" {
			statusEvent = &reports[i]
			break
		}
	}
	if statusEvent == nil {
		t.Fatalf("expected at least one status-event report, got phases: %v", phasesOf(reports))
	}
	if statusEvent.Event == nil {
		t.Fatal("status-event report has nil Event")
	}
	if statusEvent.Event.Kind != "progress" {
		t.Errorf("want kind=progress, got %s", statusEvent.Event.Kind)
	}
	if statusEvent.Event.ProgressPct == nil || *statusEvent.Event.ProgressPct != 65 {
		t.Errorf("want progressPct=65, got %v", statusEvent.Event.ProgressPct)
	}
	if statusEvent.Event.RemainingMin == nil || *statusEvent.Event.RemainingMin != 20 {
		t.Errorf("want remainingMin=20, got %v", statusEvent.Event.RemainingMin)
	}
	if statusEvent.JobID != "jobProgress" {
		t.Errorf("want jobID=jobProgress, got %s", statusEvent.JobID)
	}
}

func TestSubscribe_PrintDone_CompletedPhase_NoMaterials(t *testing.T) {
	msg := innerMsg(t, map[string]any{
		"event": map[string]any{
			"type":    "PrintDone",
			"payload": map[string]any{"name": "ring.gcode"},
		},
	})
	frame := sockJsArrayFrame(msg)

	dialFn := func(rawURL string) (wsConn, error) {
		return newFakeConn([]byte("o"), frame), nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 80, Scheme: "http", APIPath: "/api", RequiresAuth: false}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobDone", spy, nil, dialFn, nil)

	completedReport, ok := spy.firstByPhase("completed")
	if !ok {
		t.Fatalf("expected a completed phase report, got phases: %v", phasesOf(spy.allReports()))
	}
	// OctoPrint must NOT populate materials_used.
	if len(completedReport.MaterialsUsed) != 0 {
		t.Errorf("expected no materials_used (OctoPrint does not track grams), got %v", completedReport.MaterialsUsed)
	}
}

func TestSubscribe_PrintFailed_Cancelled_FailedPhase(t *testing.T) {
	msg := innerMsg(t, map[string]any{
		"event": map[string]any{
			"type":    "PrintFailed",
			"payload": map[string]any{"reason": "cancelled"},
		},
	})
	frame := sockJsArrayFrame(msg)

	dialFn := func(rawURL string) (wsConn, error) {
		return newFakeConn([]byte("o"), frame), nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 80, Scheme: "http", APIPath: "/api", RequiresAuth: false}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobCancelled", spy, nil, dialFn, nil)

	failedReport, ok := spy.firstByPhase("failed")
	if !ok {
		t.Fatalf("expected a failed phase report, got phases: %v", phasesOf(spy.allReports()))
	}
	if failedReport.Reason != "rejected" {
		t.Errorf("reason: got %q, want \"rejected\"", failedReport.Reason)
	}
}

func TestSubscribe_SpoolManagerWarning_WarningEvent(t *testing.T) {
	msg := innerMsg(t, map[string]any{
		"plugin": map[string]any{
			"plugin": "OctoPrint-Spool Manager",
			"data":   map[string]any{"code": "filament_low", "message": "Low"},
		},
	})
	frame := sockJsArrayFrame(msg)

	dialFn := func(rawURL string) (wsConn, error) {
		return newFakeConn([]byte("o"), frame), nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 80, Scheme: "http", APIPath: "/api", RequiresAuth: false}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobWarn", spy, nil, dialFn, nil)

	reports := spy.allReports()
	var warningReport *central.StatusReport
	for i := range reports {
		if reports[i].Phase == "status-event" && reports[i].Event != nil && reports[i].Event.Kind == "warning" {
			warningReport = &reports[i]
			break
		}
	}
	if warningReport == nil {
		t.Fatalf("expected a warning status-event, got: %v", phasesOf(reports))
	}
	if warningReport.Event.ErrorCode != "OctoPrint-Spool Manager/filament_low" {
		t.Errorf("errorCode: got %q", warningReport.Event.ErrorCode)
	}
}

func TestSubscribe_HeartbeatIgnored(t *testing.T) {
	dialFn := func(rawURL string) (wsConn, error) {
		return newFakeConn([]byte("o"), []byte("h"), []byte("h")), nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 80, Scheme: "http", APIPath: "/api", RequiresAuth: false}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobHB", spy, nil, dialFn, nil)

	reports := spy.allReports()
	if len(reports) != 0 {
		t.Errorf("heartbeat frames should produce no reports, got %d", len(reports))
	}
}

func TestSubscribe_HistoryFrame_TreatedLikeCurrent(t *testing.T) {
	// history shape is identical to current — should emit a progress event.
	msg := innerMsg(t, map[string]any{
		"history": map[string]any{
			"state":    map[string]any{"text": "Printing"},
			"progress": map[string]any{"completion": 10.0},
			"job":      map[string]any{"file": map[string]any{"name": "test.gcode"}},
		},
	})
	frame := sockJsArrayFrame(msg)

	dialFn := func(rawURL string) (wsConn, error) {
		return newFakeConn([]byte("o"), frame), nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 80, Scheme: "http", APIPath: "/api", RequiresAuth: false}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobHistory", spy, nil, dialFn, nil)

	reports := spy.allReports()
	var found bool
	for _, r := range reports {
		if r.Phase == "status-event" && r.Event != nil && r.Event.Kind == "progress" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("history Printing frame should emit progress event, got: %v", phasesOf(reports))
	}
}

// ---------------------------------------------------------------------------
// Helper types for capture
// ---------------------------------------------------------------------------

type captureWriteConn struct {
	inner   wsConn
	mu      sync.Mutex
	written [][]byte
}

func (c *captureWriteConn) ReadMessage() ([]byte, error) { return c.inner.ReadMessage() }
func (c *captureWriteConn) Close() error                 { return c.inner.Close() }
func (c *captureWriteConn) WriteMessage(msg []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([]byte, len(msg))
	copy(cp, msg)
	c.written = append(c.written, cp)
	return c.inner.WriteMessage(msg)
}
func (c *captureWriteConn) Written() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([][]byte, len(c.written))
	copy(cp, c.written)
	return cp
}

type captureWriteFlagConn struct {
	inner wsConn
	flag  *bool
}

func (c *captureWriteFlagConn) ReadMessage() ([]byte, error) { return c.inner.ReadMessage() }
func (c *captureWriteFlagConn) Close() error                 { return c.inner.Close() }
func (c *captureWriteFlagConn) WriteMessage(msg []byte) error {
	*c.flag = true
	return c.inner.WriteMessage(msg)
}
