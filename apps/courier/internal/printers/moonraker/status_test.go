package moonraker

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// ---------------------------------------------------------------------------
// Helpers — fixture builders
// ---------------------------------------------------------------------------

// makeStatusUpdateFrame builds a raw notify_status_update JSON frame.
func makeStatusUpdateFrame(t *testing.T, printStats map[string]any, displayStatus map[string]any, virtualSD map[string]any) []byte {
	t.Helper()
	payload := map[string]any{}
	if printStats != nil {
		payload["print_stats"] = printStats
	}
	if displayStatus != nil {
		payload["display_status"] = displayStatus
	}
	if virtualSD != nil {
		payload["virtual_sdcard"] = virtualSD
	}
	frame := map[string]any{
		"jsonrpc": "2.0",
		"method":  "notify_status_update",
		"params":  []any{payload, 12345.678}, // params[1] = eventtime
	}
	b, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("makeStatusUpdateFrame: %v", err)
	}
	return b
}

// makeHistoryChangedFrame builds a raw notify_history_changed JSON frame.
func makeHistoryChangedFrame(t *testing.T, action string, job map[string]any) []byte {
	t.Helper()
	entry := map[string]any{
		"action": action,
		"job":    job,
	}
	frame := map[string]any{
		"jsonrpc": "2.0",
		"method":  "notify_history_changed",
		"params":  []any{entry},
	}
	b, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("makeHistoryChangedFrame: %v", err)
	}
	return b
}

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

// ---------------------------------------------------------------------------
// Fake wsConn
// ---------------------------------------------------------------------------

type fakeConn struct {
	mu      sync.Mutex
	frames  [][]byte
	pos     int
	closed  bool
	written [][]byte
	blockCh chan struct{} // if non-nil, ReadMessage blocks until closed
}

func newFakeConn(frames ...[]byte) *fakeConn {
	return &fakeConn{frames: frames}
}

// newBlockingFakeConn creates a fakeConn that serves the given frames then
// blocks until Unblock is called.
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
	// No more frames — block or return EOF.
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
	f.written = append(f.written, msg)
	return nil
}

func (f *fakeConn) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
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
// Unit tests — pure state machine
// ---------------------------------------------------------------------------

func TestStateMachine_StatusUpdate_Printing(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	frame := makeStatusUpdateFrame(t,
		map[string]any{"state": "printing", "filename": "benchy.gcode"},
		map[string]any{"progress": 0.42},
		nil,
	)

	intents := sm.handleStatusUpdate(parseStatusPayload(t, frame), nil, time.Now())

	if len(intents) != 1 {
		t.Fatalf("want 1 intent, got %d", len(intents))
	}
	got := intents[0]
	if got.kind != reportKindStatusEvent {
		t.Errorf("want reportKindStatusEvent, got %v", got.kind)
	}
	if got.eventKind != kindProgress {
		t.Errorf("want kindProgress, got %s", got.eventKind)
	}
	if got.remoteJobRef != "benchy.gcode" {
		t.Errorf("want remoteJobRef=benchy.gcode, got %s", got.remoteJobRef)
	}
	if got.progressPct == nil || *got.progressPct != 42 {
		t.Errorf("want progressPct=42, got %v", got.progressPct)
	}
}

func TestStateMachine_StatusUpdate_Standby_Ignored(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	frame := makeStatusUpdateFrame(t,
		map[string]any{"state": "standby"},
		nil, nil,
	)
	intents := sm.handleStatusUpdate(parseStatusPayload(t, frame), nil, time.Now())
	if len(intents) != 0 {
		t.Errorf("standby should produce no intents, got %d", len(intents))
	}
}

func TestStateMachine_StatusUpdate_NoState_Ignored(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	// A partial update with only filament_used (no state) — common in Klipper.
	frame := makeStatusUpdateFrame(t,
		map[string]any{"filament_used": 500.0},
		nil, nil,
	)
	intents := sm.handleStatusUpdate(parseStatusPayload(t, frame), nil, time.Now())
	if len(intents) != 0 {
		t.Errorf("update with no state should produce no intents, got %d", len(intents))
	}
	// But filament_used should have been tracked.
	if sm.latestFilamentUsedMm == nil || *sm.latestFilamentUsedMm != 500.0 {
		t.Errorf("want latestFilamentUsedMm=500, got %v", sm.latestFilamentUsedMm)
	}
}

func TestStateMachine_FilamentTracking_AndCompleted(t *testing.T) {
	const density = 1.24
	const diameter = 1.75
	const filamentMm = 2345.6

	sm := newStateMachine(density, diameter)

	// First frame: partial update, just filament_used.
	frame1 := makeStatusUpdateFrame(t,
		map[string]any{"filament_used": filamentMm},
		nil, nil,
	)
	intents1 := sm.handleStatusUpdate(parseStatusPayload(t, frame1), nil, time.Now())
	if len(intents1) != 0 {
		t.Errorf("partial update without state should yield no intents")
	}
	if sm.latestFilamentUsedMm == nil || *sm.latestFilamentUsedMm != filamentMm {
		t.Fatalf("filament tracking failed: want %.2f, got %v", filamentMm, sm.latestFilamentUsedMm)
	}

	// Second frame: state=complete.
	frame2 := makeStatusUpdateFrame(t,
		map[string]any{"state": "complete", "filename": "test.gcode"},
		nil, nil,
	)
	intents2 := sm.handleStatusUpdate(parseStatusPayload(t, frame2), nil, time.Now())

	// Expect a status-event (kind=completed) + a completed report.
	if len(intents2) != 2 {
		t.Fatalf("want 2 intents for complete state, got %d", len(intents2))
	}
	statusIntent := intents2[0]
	completedIntent := intents2[1]

	if statusIntent.eventKind != kindCompleted {
		t.Errorf("status intent: want kindCompleted, got %s", statusIntent.eventKind)
	}
	if completedIntent.kind != reportKindCompleted {
		t.Errorf("second intent: want reportKindCompleted, got %v", completedIntent.kind)
	}

	// Verify mm→grams formula.
	expectedGrams := filamentMmToGrams(filamentMm, diameter, density)
	if math.Abs(completedIntent.measuredGrams-expectedGrams) > 1e-6 {
		t.Errorf("measuredGrams: want %.6f, got %.6f", expectedGrams, completedIntent.measuredGrams)
	}
}

func TestFilamentMmToGrams_Formula(t *testing.T) {
	// Reference: PLA 1.75mm diameter, density 1.24 g/cm³, 1000 mm length.
	// radius = 0.875 mm
	// volume = π * 0.875^2 * 1000 mm³ = π * 0.765625 * 1000 ≈ 2404.82 mm³
	// cm³ = 2404.82 / 1000 ≈ 2.40482
	// grams = 2.40482 * 1.24 ≈ 2.98
	grams := filamentMmToGrams(1000.0, 1.75, 1.24)
	expected := math.Pi * math.Pow(1.75/2, 2) * 1000.0 / 1000.0 * 1.24
	if math.Abs(grams-expected) > 1e-9 {
		t.Errorf("formula: want %.9f, got %.9f", expected, grams)
	}
	// Sanity check against known approximate value.
	if math.Abs(grams-2.98) > 0.01 {
		t.Errorf("expected ~2.98 g per meter PLA, got %.4f", grams)
	}
}

func TestStateMachine_HistoryChanged_Completed(t *testing.T) {
	const filamentMm = 5000.0
	const density = 1.24
	const diameter = 1.75

	sm := newStateMachine(density, diameter)
	// Pre-load filament tracking.
	sm.latestFilamentUsedMm = ptrFloat(filamentMm)

	frame := makeHistoryChangedFrame(t, "finished", map[string]any{
		"status":   "completed",
		"filename": "print.gcode",
	})
	entry := parseHistoryEntry(t, frame)
	intents := sm.handleHistoryChanged(entry, nil, time.Now())

	if len(intents) != 2 {
		t.Fatalf("want 2 intents for completed history, got %d", len(intents))
	}
	statusIntent := intents[0]
	completedIntent := intents[1]

	if statusIntent.eventKind != kindCompleted {
		t.Errorf("status intent kind: want kindCompleted, got %s", statusIntent.eventKind)
	}
	if completedIntent.kind != reportKindCompleted {
		t.Errorf("second intent: want reportKindCompleted, got %v", completedIntent.kind)
	}
	expectedGrams := filamentMmToGrams(filamentMm, diameter, density)
	if math.Abs(completedIntent.measuredGrams-expectedGrams) > 1e-6 {
		t.Errorf("measuredGrams: want %.6f, got %.6f", expectedGrams, completedIntent.measuredGrams)
	}
}

func TestStateMachine_HistoryChanged_Cancelled(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	frame := makeHistoryChangedFrame(t, "finished", map[string]any{
		"status":   "cancelled",
		"filename": "print.gcode",
	})
	entry := parseHistoryEntry(t, frame)
	intents := sm.handleHistoryChanged(entry, nil, time.Now())

	if len(intents) != 2 {
		t.Fatalf("want 2 intents for cancelled, got %d", len(intents))
	}
	if intents[0].eventKind != kindCancelled {
		t.Errorf("want kindCancelled, got %s", intents[0].eventKind)
	}
	if intents[1].kind != reportKindFailed {
		t.Errorf("want reportKindFailed, got %v", intents[1].kind)
	}
	if intents[1].reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", intents[1].reason)
	}
}

func TestStateMachine_HistoryChanged_Interrupted(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	frame := makeHistoryChangedFrame(t, "finished", map[string]any{
		"status": "interrupted",
	})
	entry := parseHistoryEntry(t, frame)
	intents := sm.handleHistoryChanged(entry, nil, time.Now())

	if len(intents) != 2 {
		t.Fatalf("want 2 intents for interrupted, got %d", len(intents))
	}
	// interrupted → cancelled (matches Node subscriber)
	if intents[0].eventKind != kindCancelled {
		t.Errorf("interrupted: want kindCancelled, got %s", intents[0].eventKind)
	}
}

func TestStateMachine_HistoryChanged_KlippyShutdown(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	frame := makeHistoryChangedFrame(t, "finished", map[string]any{
		"status": "klippy_shutdown",
	})
	entry := parseHistoryEntry(t, frame)
	intents := sm.handleHistoryChanged(entry, nil, time.Now())

	if len(intents) != 2 {
		t.Fatalf("want 2 intents for klippy_shutdown, got %d", len(intents))
	}
	if intents[0].eventKind != kindFirmwareError {
		t.Errorf("klippy_shutdown: want kindFirmwareError, got %s", intents[0].eventKind)
	}
	if intents[0].errorCode != "klippy_shutdown" {
		t.Errorf("want errorCode=klippy_shutdown, got %s", intents[0].errorCode)
	}
	if intents[1].reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", intents[1].reason)
	}
}

func TestStateMachine_HistoryChanged_KlippyDisconnect(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	frame := makeHistoryChangedFrame(t, "finished", map[string]any{
		"status": "klippy_disconnect",
	})
	entry := parseHistoryEntry(t, frame)
	intents := sm.handleHistoryChanged(entry, nil, time.Now())
	if intents[0].errorCode != "klippy_disconnect" {
		t.Errorf("want errorCode=klippy_disconnect, got %s", intents[0].errorCode)
	}
}

func TestStateMachine_HistoryChanged_ServerExit(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	frame := makeHistoryChangedFrame(t, "finished", map[string]any{
		"status": "server_exit",
	})
	entry := parseHistoryEntry(t, frame)
	intents := sm.handleHistoryChanged(entry, nil, time.Now())
	if intents[0].errorCode != "server_exit" {
		t.Errorf("want errorCode=server_exit, got %s", intents[0].errorCode)
	}
}

func TestStateMachine_HistoryChanged_UnknownStatus_Failed(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	frame := makeHistoryChangedFrame(t, "finished", map[string]any{
		"status": "some_unknown_terminal_state",
	})
	entry := parseHistoryEntry(t, frame)
	intents := sm.handleHistoryChanged(entry, nil, time.Now())

	if len(intents) != 2 {
		t.Fatalf("want 2 intents for unknown status, got %d", len(intents))
	}
	if intents[0].eventKind != kindFailed {
		t.Errorf("unknown status: want kindFailed, got %s", intents[0].eventKind)
	}
	if intents[1].reason != "unknown" {
		t.Errorf("want reason=unknown, got %s", intents[1].reason)
	}
}

func TestStateMachine_HistoryChanged_ActionNotFinished_Ignored(t *testing.T) {
	sm := newStateMachine(1.24, 1.75)
	frame := makeHistoryChangedFrame(t, "added", map[string]any{
		"status": "completed",
	})
	entry := parseHistoryEntry(t, frame)
	intents := sm.handleHistoryChanged(entry, nil, time.Now())
	if len(intents) != 0 {
		t.Errorf("non-finished action should be ignored, got %d intents", len(intents))
	}
}

// ---------------------------------------------------------------------------
// Subscribe message content test
// ---------------------------------------------------------------------------

func TestSubscribeMessage_Content(t *testing.T) {
	var parsed map[string]any
	if err := json.Unmarshal(subscribeMessage, &parsed); err != nil {
		t.Fatalf("subscribeMessage is not valid JSON: %v", err)
	}
	if parsed["jsonrpc"] != "2.0" {
		t.Errorf("want jsonrpc=2.0, got %v", parsed["jsonrpc"])
	}
	if parsed["method"] != "printer.objects.subscribe" {
		t.Errorf("want method=printer.objects.subscribe, got %v", parsed["method"])
	}
	// id must be 1 (JSON number — may decode as float64)
	if id, ok := parsed["id"].(float64); !ok || id != 1 {
		t.Errorf("want id=1, got %v", parsed["id"])
	}
	params, ok := parsed["params"].(map[string]any)
	if !ok {
		t.Fatalf("want params object, got %T", parsed["params"])
	}
	objects, ok := params["objects"].(map[string]any)
	if !ok {
		t.Fatalf("want objects map in params, got %T", params["objects"])
	}
	for _, key := range []string{"print_stats", "display_status", "virtual_sdcard", "webhooks"} {
		if _, exists := objects[key]; !exists {
			t.Errorf("subscribe objects missing key: %s", key)
		}
	}
	// Check print_stats fields include the required set.
	psFields, ok := objects["print_stats"].([]any)
	if !ok {
		t.Fatalf("print_stats is not a slice, got %T", objects["print_stats"])
	}
	required := map[string]bool{
		"state": false, "filename": false, "print_duration": false,
		"total_duration": false, "filament_used": false, "info": false, "message": false,
	}
	for _, f := range psFields {
		if s, ok := f.(string); ok {
			required[s] = true
		}
	}
	for field, found := range required {
		if !found {
			t.Errorf("subscribe message missing print_stats field: %s", field)
		}
	}
}

// ---------------------------------------------------------------------------
// URL construction tests (ws vs wss, port, X-Api-Key)
// ---------------------------------------------------------------------------

func TestSubscribe_WSSForHTTPS(t *testing.T) {
	var capturedURL string
	var capturedHeader http.Header

	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		capturedURL = rawURL
		capturedHeader = header
		// Return a fakeConn that serves one unknown frame then EOF.
		conn := newFakeConn([]byte(`{"jsonrpc":"2.0","method":"unknown"}`))
		return conn, nil
	}

	cfg := ConnectionConfig{
		Host:         "printer.local",
		Port:         7125,
		Scheme:       "https",
		RequiresAuth: false,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "job1", spy, 1.24, 1.75, nil, dialFn)

	if capturedURL != "wss://printer.local:7125/websocket" {
		t.Errorf("want wss URL, got %s", capturedURL)
	}
	if capturedHeader.Get("X-Api-Key") != "" {
		t.Errorf("expected no X-Api-Key header when requiresAuth=false")
	}
}

func TestSubscribe_WSForHTTP(t *testing.T) {
	var capturedURL string

	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		capturedURL = rawURL
		conn := newFakeConn([]byte(`{"jsonrpc":"2.0","method":"unknown"}`))
		return conn, nil
	}

	cfg := ConnectionConfig{
		Host:         "192.168.1.100",
		Port:         7125,
		Scheme:       "http",
		RequiresAuth: false,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "job1", spy, 1.24, 1.75, nil, dialFn)

	if capturedURL != "ws://192.168.1.100:7125/websocket" {
		t.Errorf("want ws URL, got %s", capturedURL)
	}
}

func TestSubscribe_XApiKeyHeaderSetWhenRequiresAuth(t *testing.T) {
	var capturedHeader http.Header

	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		capturedHeader = header
		conn := newFakeConn([]byte(`{"jsonrpc":"2.0","method":"unknown"}`))
		return conn, nil
	}

	cfg := ConnectionConfig{
		Host:         "printer.local",
		Port:         7125,
		Scheme:       "http",
		RequiresAuth: true,
	}
	cred := &Credential{APIKey: "secret-key-abc"}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, cred, "job1", spy, 1.24, 1.75, nil, dialFn)

	if capturedHeader.Get("X-Api-Key") != "secret-key-abc" {
		t.Errorf("expected X-Api-Key=secret-key-abc, got %q", capturedHeader.Get("X-Api-Key"))
	}
}

func TestSubscribe_XApiKeyNotSetWhenNoCred(t *testing.T) {
	var capturedHeader http.Header

	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		capturedHeader = header
		conn := newFakeConn([]byte(`{"jsonrpc":"2.0","method":"unknown"}`))
		return conn, nil
	}

	cfg := ConnectionConfig{
		Host:         "printer.local",
		Port:         7125,
		Scheme:       "http",
		RequiresAuth: true,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	// nil cred — should not set header
	_ = subscribeWithDialer(ctx, cfg, nil, "job1", spy, 1.24, 1.75, nil, dialFn)

	if capturedHeader.Get("X-Api-Key") != "" {
		t.Errorf("expected no X-Api-Key header when cred is nil, got %q", capturedHeader.Get("X-Api-Key"))
	}
}

// ---------------------------------------------------------------------------
// Subscribe message sent on open
// ---------------------------------------------------------------------------

func TestSubscribe_SendsSubscribeMessageOnOpen(t *testing.T) {
	var written [][]byte

	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		conn := &fakeConn{
			frames:  [][]byte{[]byte(`{"jsonrpc":"2.0","method":"unknown"}`)},
			blockCh: make(chan struct{}),
		}
		// Capture writes via a wrapper.
		return &writeCapturingConn{inner: conn, out: &written}, nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 7125, Scheme: "http"}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "job1", spy, 1.24, 1.75, nil, dialFn)

	if len(written) == 0 {
		t.Fatal("expected subscribe message to be written, got none")
	}
	var parsed map[string]any
	if err := json.Unmarshal(written[0], &parsed); err != nil {
		t.Fatalf("first write is not valid JSON: %v", err)
	}
	if parsed["method"] != "printer.objects.subscribe" {
		t.Errorf("first write method: want printer.objects.subscribe, got %v", parsed["method"])
	}
}

// writeCapturingConn delegates to an inner wsConn and records all writes.
type writeCapturingConn struct {
	inner wsConn
	out   *[][]byte
}

func (w *writeCapturingConn) ReadMessage() ([]byte, error) { return w.inner.ReadMessage() }
func (w *writeCapturingConn) Close() error                 { return w.inner.Close() }
func (w *writeCapturingConn) WriteMessage(msg []byte) error {
	cp := make([]byte, len(msg))
	copy(cp, msg)
	*w.out = append(*w.out, cp)
	return w.inner.WriteMessage(msg)
}

// ---------------------------------------------------------------------------
// Subscribe — context cancel and read error → clean return
// ---------------------------------------------------------------------------

func TestSubscribe_CtxCancel_CleanReturn(t *testing.T) {
	blocking := newBlockingFakeConn()

	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		return blocking, nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 7125, Scheme: "http"}
	ctx, cancel := context.WithCancel(context.Background())

	errCh := make(chan error, 1)
	go func() {
		spy := &spyReporter{}
		errCh <- subscribeWithDialer(ctx, cfg, nil, "job1", spy, 1.24, 1.75, nil, dialFn)
	}()

	// Give the goroutine time to start, then cancel.
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
	// Conn that immediately returns an error on read.
	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		return newFakeConn(), nil // no frames → immediate EOF
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 7125, Scheme: "http"}
	ctx := context.Background()
	spy := &spyReporter{}

	err := subscribeWithDialer(ctx, cfg, nil, "job1", spy, 1.24, 1.75, nil, dialFn)
	if err == nil {
		t.Error("expected error on read EOF, got nil")
	}
}

// ---------------------------------------------------------------------------
// End-to-end: run frames through subscribeWithDialer and check reports
// ---------------------------------------------------------------------------

func TestSubscribe_ProgressReport_EndToEnd(t *testing.T) {
	frame := makeStatusUpdateFrame(t,
		map[string]any{"state": "printing", "filename": "cube.gcode"},
		map[string]any{"progress": 0.65},
		nil,
	)

	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		return newFakeConn(frame), nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 7125, Scheme: "http"}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobXYZ", spy, 1.24, 1.75, nil, dialFn)

	reports := spy.allReports()
	var statusEvent *central.StatusReport
	for i := range reports {
		if reports[i].Phase == "status-event" {
			statusEvent = &reports[i]
			break
		}
	}
	if statusEvent == nil {
		t.Fatalf("expected at least one status-event report, got none")
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
	if statusEvent.JobID != "jobXYZ" {
		t.Errorf("want jobID=jobXYZ, got %s", statusEvent.JobID)
	}
}

func TestSubscribe_CompletedReport_EndToEnd(t *testing.T) {
	const filamentMm = 3000.0

	// Send a filament tracking update first, then the complete state.
	frame1 := makeStatusUpdateFrame(t,
		map[string]any{"filament_used": filamentMm},
		nil, nil,
	)
	frame2 := makeStatusUpdateFrame(t,
		map[string]any{"state": "complete", "filename": "ring.gcode"},
		nil, nil,
	)

	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		return newFakeConn(frame1, frame2), nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 7125, Scheme: "http"}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobABC", spy, 1.24, 1.75, nil, dialFn)

	// Should have a completed report with the measured grams.
	completedReport, ok := spy.firstByPhase("completed")
	if !ok {
		t.Fatalf("expected a completed phase report, phases seen: %v", phasesOf(spy.allReports()))
	}
	expectedGrams := filamentMmToGrams(filamentMm, 1.75, 1.24)
	if len(completedReport.MaterialsUsed) == 0 {
		t.Fatalf("expected materials_used to be populated")
	}
	if math.Abs(completedReport.MaterialsUsed[0].MeasuredGrams-expectedGrams) > 1e-6 {
		t.Errorf("measuredGrams: want %.6f, got %.6f", expectedGrams, completedReport.MaterialsUsed[0].MeasuredGrams)
	}
}

func TestSubscribe_HistoryChanged_CompletedReport_EndToEnd(t *testing.T) {
	const filamentMm = 4200.0

	// Status update to track filament, then history_changed.
	frame1 := makeStatusUpdateFrame(t,
		map[string]any{"filament_used": filamentMm},
		nil, nil,
	)
	frame2 := makeHistoryChangedFrame(t, "finished", map[string]any{
		"status":   "completed",
		"filename": "vase.gcode",
	})

	dialFn := func(rawURL string, header http.Header) (wsConn, error) {
		return newFakeConn(frame1, frame2), nil
	}

	cfg := ConnectionConfig{Host: "printer.local", Port: 7125, Scheme: "http"}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	spy := &spyReporter{}
	_ = subscribeWithDialer(ctx, cfg, nil, "jobDEF", spy, 1.24, 1.75, nil, dialFn)

	completedReport, ok := spy.firstByPhase("completed")
	if !ok {
		t.Fatalf("expected completed phase report; got phases: %v", phasesOf(spy.allReports()))
	}
	expectedGrams := filamentMmToGrams(filamentMm, 1.75, 1.24)
	if len(completedReport.MaterialsUsed) == 0 {
		t.Fatal("expected materials_used populated")
	}
	got := completedReport.MaterialsUsed[0].MeasuredGrams
	if math.Abs(got-expectedGrams) > 1e-6 {
		t.Errorf("want %.6f, got %.6f", expectedGrams, got)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// parseStatusPayload extracts a moonrakerStatusPayload from a raw frame bytes
// (the notify_status_update case).
func parseStatusPayload(t *testing.T, raw []byte) moonrakerStatusPayload {
	t.Helper()
	var frame struct {
		Params []json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("parseStatusPayload unmarshal frame: %v", err)
	}
	if len(frame.Params) == 0 {
		t.Fatal("parseStatusPayload: empty params")
	}
	var payload moonrakerStatusPayload
	if err := json.Unmarshal(frame.Params[0], &payload); err != nil {
		t.Fatalf("parseStatusPayload unmarshal payload: %v", err)
	}
	return payload
}

// parseHistoryEntry extracts a moonrakerHistoryEntry from a raw frame bytes.
func parseHistoryEntry(t *testing.T, raw []byte) moonrakerHistoryEntry {
	t.Helper()
	var frame struct {
		Params []json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("parseHistoryEntry unmarshal frame: %v", err)
	}
	if len(frame.Params) == 0 {
		t.Fatal("parseHistoryEntry: empty params")
	}
	var entry moonrakerHistoryEntry
	if err := json.Unmarshal(frame.Params[0], &entry); err != nil {
		t.Fatalf("parseHistoryEntry unmarshal entry: %v", err)
	}
	return entry
}

func phasesOf(reports []central.StatusReport) []string {
	phases := make([]string, 0, len(reports))
	for _, r := range reports {
		phases = append(phases, r.Phase)
	}
	return phases
}

func ptrFloat(v float64) *float64 { return &v }
