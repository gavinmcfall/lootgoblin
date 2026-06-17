package bambu

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"
	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// ---------------------------------------------------------------------------
// Spy reporter
// ---------------------------------------------------------------------------

type bambuSpyReporter struct {
	mu      sync.Mutex
	reports []central.StatusReport
}

func (s *bambuSpyReporter) ReportStatus(_ context.Context, r central.StatusReport) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reports = append(s.reports, r)
	return nil
}

func (s *bambuSpyReporter) all() []central.StatusReport {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]central.StatusReport, len(s.reports))
	copy(out, s.reports)
	return out
}

func (s *bambuSpyReporter) statusEvents() []central.StatusReport {
	var out []central.StatusReport
	for _, r := range s.all() {
		if r.Phase == "status-event" {
			out = append(out, r)
		}
	}
	return out
}

func (s *bambuSpyReporter) find(phase string) *central.StatusReport {
	for _, r := range s.all() {
		r := r
		if r.Phase == phase {
			return &r
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Fake MQTT status client — drives payloads into the Subscribe handler.
// ---------------------------------------------------------------------------

// fakeMqttStatusClient implements SubscribingMqttClient. Tests call Feed() to
// inject raw MQTT payloads into the registered handler synchronously.
type fakeMqttStatusClient struct {
	mu      sync.Mutex
	handler paho.MessageHandler
	topic   string
}

func (f *fakeMqttStatusClient) Connect() paho.Token { return &statusFakeToken{} }
func (f *fakeMqttStatusClient) Disconnect(_ uint)   {}
func (f *fakeMqttStatusClient) Publish(_ string, _ byte, _ bool, _ any) paho.Token {
	return &statusFakeToken{}
}

func (f *fakeMqttStatusClient) Subscribe(topic string, _ byte, cb paho.MessageHandler) paho.Token {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.topic = topic
	f.handler = cb
	return &statusFakeToken{}
}

// Feed pushes raw bytes as an MQTT message into the registered handler.
func (f *fakeMqttStatusClient) Feed(payload []byte) {
	f.mu.Lock()
	h := f.handler
	topic := f.topic
	f.mu.Unlock()
	if h == nil {
		return
	}
	h(nil, &statusFakeMessage{topic: topic, payload: payload})
}

// statusFakeToken satisfies paho.Token (synchronous no-op).
// Named with "status" prefix to avoid collision with dispatch_test's fakeToken.
type statusFakeToken struct{}

func (t *statusFakeToken) Wait() bool                       { return true }
func (t *statusFakeToken) WaitTimeout(_ time.Duration) bool { return true }
func (t *statusFakeToken) Done() <-chan struct{}            { ch := make(chan struct{}); close(ch); return ch }
func (t *statusFakeToken) Error() error                     { return nil }

// statusFakeMessage satisfies paho.Message.
// Named with "status" prefix to avoid collision with dispatch_test types.
type statusFakeMessage struct {
	topic   string
	payload []byte
}

func (m *statusFakeMessage) Duplicate() bool   { return false }
func (m *statusFakeMessage) Qos() byte         { return 0 }
func (m *statusFakeMessage) Retained() bool    { return false }
func (m *statusFakeMessage) Topic() string     { return m.topic }
func (m *statusFakeMessage) MessageID() uint16 { return 0 }
func (m *statusFakeMessage) Payload() []byte   { return m.payload }
func (m *statusFakeMessage) Ack()              {}

// ---------------------------------------------------------------------------
// Helpers — recorded payload builders
// ---------------------------------------------------------------------------

func mustMarshalBambu(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("mustMarshalBambu: %v", err)
	}
	return b
}

func makePrintPayload(t *testing.T, state string, extras map[string]any) []byte {
	t.Helper()
	print := map[string]any{"gcode_state": state}
	for k, v := range extras {
		print[k] = v
	}
	return mustMarshalBambu(t, map[string]any{"print": print})
}

// ---------------------------------------------------------------------------
// Pure helper tests — mapBambuState
// ---------------------------------------------------------------------------

func TestMapBambuState_AllValues(t *testing.T) {
	tests := []struct {
		state string
		want  bambuStatusKind
		ok    bool
	}{
		{"IDLE", "", false},
		{"PREPARE", bambuKindStarted, true},
		{"RUNNING", bambuKindProgress, true},
		{"PAUSE", bambuKindPaused, true},
		{"FINISH", bambuKindCompleted, true},
		{"FAILED", bambuKindFirmwareError, true},
		{"", "", false},
		{"UNKNOWN_STATE", "", false},
	}
	for _, tt := range tests {
		got, ok := mapBambuState(tt.state)
		if ok != tt.ok {
			t.Errorf("mapBambuState(%q): ok=%v want %v", tt.state, ok, tt.ok)
		}
		if ok && got != tt.want {
			t.Errorf("mapBambuState(%q): kind=%v want %v", tt.state, got, tt.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Pure helper tests — formatHmsCode
// ---------------------------------------------------------------------------

func TestFormatHmsCode(t *testing.T) {
	// attr=0x0300_5000, code=0x0700_4000 → "0300-5000-0700-4000"
	got := formatHmsCode(0x03005000, 0x07004000)
	if got != "0300-5000-0700-4000" {
		t.Errorf("formatHmsCode: got %q want %q", got, "0300-5000-0700-4000")
	}
	// All-zeros.
	got = formatHmsCode(0, 0)
	if got != "0000-0000-0000-0000" {
		t.Errorf("formatHmsCode(0,0): got %q want %q", got, "0000-0000-0000-0000")
	}
}

// ---------------------------------------------------------------------------
// Pure helper tests — hmsLevelToSeverity
// ---------------------------------------------------------------------------

func TestHmsLevelToSeverity(t *testing.T) {
	cases := []struct {
		level float64
		want  string
	}{
		{0, "info"},
		{0.9, "info"},
		{1, "warning"},
		{1.9, "warning"},
		{2, "error"},
		{3, "error"},
	}
	for _, tc := range cases {
		got := hmsLevelToSeverity(tc.level)
		if got != tc.want {
			t.Errorf("hmsLevelToSeverity(%.1f): got %q want %q", tc.level, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Pure helper tests — extractAmsSlots
// ---------------------------------------------------------------------------

func TestExtractAmsSlots_Basic(t *testing.T) {
	ams := &bambuAmsBlock{
		Ams: []bambuAmsUnit{
			{
				Tray: []bambuTrayPayload{
					{ID: strPtr("0"), Remain: float64Ptr(80)},
					{ID: strPtr("1"), Remain: float64Ptr(60)},
				},
			},
			{
				Tray: []bambuTrayPayload{
					{ID: strPtr("2"), Remain: float64Ptr(40)},
				},
			},
		},
	}
	slots := extractAmsSlots(ams)
	if len(slots) != 3 {
		t.Fatalf("expected 3 slots, got %d", len(slots))
	}
	// unit0 tray0 → slot 0
	if slots[0].SlotIndex != 0 || slots[0].Grams != 0 || *slots[0].RemainPercent != 80 {
		t.Errorf("slot[0] unexpected: %+v", slots[0])
	}
	// unit0 tray1 → slot 1
	if slots[1].SlotIndex != 1 || *slots[1].RemainPercent != 60 {
		t.Errorf("slot[1] unexpected: %+v", slots[1])
	}
	// unit1 tray2 → slot 4+2=6
	if slots[2].SlotIndex != 6 || *slots[2].RemainPercent != 40 {
		t.Errorf("slot[2] unexpected: %+v", slots[2])
	}
}

func TestExtractAmsSlots_Nil(t *testing.T) {
	if slots := extractAmsSlots(nil); len(slots) != 0 {
		t.Errorf("expected empty slots for nil ams, got %d", len(slots))
	}
}

// ---------------------------------------------------------------------------
// buildBambuIntents pure tests
// ---------------------------------------------------------------------------

func TestBuildBambuIntents_Progress(t *testing.T) {
	last := ""
	pct := 42.0
	layer := 10
	total := 100
	rem := 180.0 // seconds → 3 min
	p := &bambuPrintPayload{
		GcodeState:      strPtr("RUNNING"),
		McPercent:       &pct,
		LayerNum:        &layer,
		TotalLayerNum:   &total,
		McRemainingTime: &rem,
		SubtaskName:     strPtr("my_job.3mf"),
	}
	intents := buildBambuIntents(nil, p, &last, time.Now())
	if len(intents) != 1 {
		t.Fatalf("expected 1 intent, got %d", len(intents))
	}
	i := intents[0]
	if i.kind != bambuKindProgress {
		t.Errorf("kind: got %v want progress", i.kind)
	}
	if i.remoteJobRef != "my_job.3mf" {
		t.Errorf("remoteJobRef: got %q", i.remoteJobRef)
	}
	if i.progressPct == nil || *i.progressPct != 42 {
		t.Errorf("progressPct: got %v", i.progressPct)
	}
	if i.layerNum == nil || *i.layerNum != 10 {
		t.Errorf("layerNum: got %v", i.layerNum)
	}
	if i.totalLayers == nil || *i.totalLayers != 100 {
		t.Errorf("totalLayers: got %v", i.totalLayers)
	}
	if i.remainingMin == nil || *i.remainingMin != 3 {
		t.Errorf("remainingMin: got %v want 3", i.remainingMin)
	}
	// No terminal reports.
	if i.isCompleted || i.isFailed {
		t.Errorf("unexpected terminal flags: completed=%v failed=%v", i.isCompleted, i.isFailed)
	}
}

func TestBuildBambuIntents_Completed_NoMaterialsUsed(t *testing.T) {
	last := "RUNNING"
	trayRemain := 75.0
	p := &bambuPrintPayload{
		GcodeState:  strPtr("FINISH"),
		SubtaskName: strPtr("box.3mf"),
		Ams: &bambuAmsBlock{
			Ams: []bambuAmsUnit{
				{Tray: []bambuTrayPayload{{ID: strPtr("0"), Remain: &trayRemain}}},
			},
		},
	}
	intents := buildBambuIntents(nil, p, &last, time.Now())
	if len(intents) != 1 {
		t.Fatalf("expected 1 intent, got %d", len(intents))
	}
	i := intents[0]
	if i.kind != bambuKindCompleted {
		t.Errorf("kind: got %v want completed", i.kind)
	}
	if !i.isCompleted {
		t.Error("isCompleted should be true")
	}
	// remain% must be in measuredConsumption.
	if len(i.measuredConsumption) != 1 {
		t.Fatalf("expected 1 slot, got %d", len(i.measuredConsumption))
	}
	slot := i.measuredConsumption[0]
	if slot.Grams != 0 {
		t.Errorf("Grams should be 0 (server refines), got %v", slot.Grams)
	}
	if slot.RemainPercent == nil || *slot.RemainPercent != 75 {
		t.Errorf("RemainPercent: got %v want 75", slot.RemainPercent)
	}
}

func TestBuildBambuIntents_FirmwareError_WithHmsCode(t *testing.T) {
	last := ""
	printErr := uint32(12345)
	attr := uint32(0x03005000)
	code := uint32(0x07004000)
	level := 2.0
	p := &bambuPrintPayload{
		GcodeState:  strPtr("FAILED"),
		PrintError:  &printErr,
		SubtaskName: strPtr("failed_job"),
		Hms:         []bambuHmsEntry{{Attr: &attr, Code: &code, Level: &level}},
	}
	intents := buildBambuIntents(nil, p, &last, time.Now())
	// Expect: 1 firmware_error + 1 warning
	if len(intents) != 2 {
		t.Fatalf("expected 2 intents (firmware_error + warning), got %d", len(intents))
	}
	fe := intents[0]
	if fe.kind != bambuKindFirmwareError {
		t.Errorf("intent[0] kind: got %v want firmware_error", fe.kind)
	}
	if fe.errorCode != "12345" {
		t.Errorf("errorCode: got %q want %q", fe.errorCode, "12345")
	}
	if !fe.isFailed {
		t.Error("isFailed should be true for firmware_error")
	}
	warn := intents[1]
	if warn.kind != bambuKindWarning {
		t.Errorf("intent[1] kind: got %v want warning", warn.kind)
	}
	if warn.errorCode != "0300-5000-0700-4000" {
		t.Errorf("HMS errorCode: got %q", warn.errorCode)
	}
	if warn.severity != "error" {
		t.Errorf("HMS severity: got %q want error", warn.severity)
	}
}

func TestBuildBambuIntents_Paused(t *testing.T) {
	last := "RUNNING"
	p := &bambuPrintPayload{GcodeState: strPtr("PAUSE"), SubtaskName: strPtr("job")}
	intents := buildBambuIntents(nil, p, &last, time.Now())
	if len(intents) != 1 || intents[0].kind != bambuKindPaused {
		t.Errorf("expected 1 paused intent, got %+v", intents)
	}
	if last != "PAUSE" {
		t.Errorf("lastGcodeState should be PAUSE, got %q", last)
	}
}

func TestBuildBambuIntents_PauseToIdle_OperatorCancel(t *testing.T) {
	last := "PAUSE"
	p := &bambuPrintPayload{GcodeState: strPtr("IDLE"), SubtaskName: strPtr("job")}
	intents := buildBambuIntents(nil, p, &last, time.Now())
	// Should produce a cancelled intent; IDLE itself is ignored.
	if len(intents) != 1 {
		t.Fatalf("expected 1 intent (cancelled), got %d: %+v", len(intents), intents)
	}
	i := intents[0]
	if i.kind != bambuKindCancelled {
		t.Errorf("kind: got %v want cancelled", i.kind)
	}
	if !i.isFailed || i.failReason != "rejected" || i.failDetails != "cancelled" {
		t.Errorf("isFailed/failReason/failDetails: %+v", i)
	}
}

func TestBuildBambuIntents_Idle_NoEvent(t *testing.T) {
	last := "RUNNING"
	p := &bambuPrintPayload{GcodeState: strPtr("IDLE")}
	intents := buildBambuIntents(nil, p, &last, time.Now())
	// RUNNING→IDLE without prior PAUSE should produce NO event.
	if len(intents) != 0 {
		t.Errorf("expected 0 intents for RUNNING→IDLE, got %d: %+v", len(intents), intents)
	}
}

func TestBuildBambuIntents_Prepare(t *testing.T) {
	last := "IDLE"
	p := &bambuPrintPayload{GcodeState: strPtr("PREPARE")}
	intents := buildBambuIntents(nil, p, &last, time.Now())
	if len(intents) != 1 || intents[0].kind != bambuKindStarted {
		t.Errorf("expected started intent, got %+v", intents)
	}
}

func TestBuildBambuIntents_NilPrint(t *testing.T) {
	last := ""
	if got := buildBambuIntents(nil, nil, &last, time.Now()); len(got) != 0 {
		t.Errorf("expected 0 intents for nil print, got %d", len(got))
	}
}

// ---------------------------------------------------------------------------
// Subscribe integration test — drives fake MQTT client
// ---------------------------------------------------------------------------

// newFakeMqttStatusFactory returns a MqttStatusClientFactory that always
// returns the given fake client.
func newFakeMqttStatusFactory(fc *fakeMqttStatusClient) MqttStatusClientFactory {
	return func(_ string, _ mqttOpts) SubscribingMqttClient {
		return fc
	}
}

func TestSubscribe_ProgressThenCompleted(t *testing.T) {
	fc := &fakeMqttStatusClient{}
	spy := &bambuSpyReporter{}

	cfg := ConnectionConfig{IP: "192.168.1.100", MqttPort: 8883}
	cred := Credential{AccessCode: "TESTCODE", Serial: "ABCD1234"}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- Subscribe(ctx, cfg, cred, "job-xyz", spy, newFakeMqttStatusFactory(fc), nil)
	}()

	// Give Subscribe time to connect and subscribe.
	time.Sleep(20 * time.Millisecond)

	pct := 50.0
	// Feed a progress event.
	fc.Feed(mustMarshalBambu(t, map[string]any{
		"print": map[string]any{
			"gcode_state":     "RUNNING",
			"mc_percent":      pct,
			"layer_num":       5,
			"total_layer_num": 100,
			"subtask_name":    "testjob.3mf",
		},
	}))

	// Feed a completed event with AMS remain%.
	trayRemain := 65.0
	fc.Feed(mustMarshalBambu(t, map[string]any{
		"print": map[string]any{
			"gcode_state":  "FINISH",
			"subtask_name": "testjob.3mf",
			"ams": map[string]any{
				"ams": []any{
					map[string]any{
						"tray": []any{
							map[string]any{"id": "0", "remain": trayRemain},
						},
					},
				},
			},
		},
	}))

	time.Sleep(30 * time.Millisecond)
	cancel()
	<-done

	// Verify status-events.
	evts := spy.statusEvents()
	if len(evts) < 2 {
		t.Fatalf("expected at least 2 status-events, got %d: %+v", len(evts), evts)
	}
	// First: progress.
	if evts[0].Event == nil || evts[0].Event.Kind != "progress" {
		t.Errorf("event[0]: want progress, got %+v", evts[0].Event)
	}
	if evts[0].Event.ProgressPct == nil || *evts[0].Event.ProgressPct != 50 {
		t.Errorf("progress_pct: got %v", evts[0].Event.ProgressPct)
	}
	// Check layer info.
	if evts[0].Event.LayerNum == nil || *evts[0].Event.LayerNum != 5 {
		t.Errorf("layer_num: got %v", evts[0].Event.LayerNum)
	}

	// Second (at least): completed.
	var completedEvt *central.StatusReport
	for _, r := range evts {
		if r.Event != nil && r.Event.Kind == "completed" {
			r := r
			completedEvt = &r
			break
		}
	}
	if completedEvt == nil {
		t.Fatal("no completed status-event found")
	}

	// completed event MUST carry remain% in measured_consumption (not materials_used).
	if len(completedEvt.Event.MeasuredConsumption) != 1 {
		t.Fatalf("completed: expected 1 slot, got %d", len(completedEvt.Event.MeasuredConsumption))
	}
	slot := completedEvt.Event.MeasuredConsumption[0]
	if slot.Grams != 0 {
		t.Errorf("completed slot Grams should be 0, got %v", slot.Grams)
	}
	if slot.RemainPercent == nil || *slot.RemainPercent != 65 {
		t.Errorf("completed slot RemainPercent: got %v want 65", slot.RemainPercent)
	}

	// The "completed" phase report must NOT carry materials_used.
	completedPhase := spy.find("completed")
	if completedPhase == nil {
		t.Fatal("no completed phase report found")
	}
	if len(completedPhase.MaterialsUsed) != 0 {
		t.Errorf("completed phase must have NO materials_used, got %+v", completedPhase.MaterialsUsed)
	}
}

func TestSubscribe_FirmwareError(t *testing.T) {
	fc := &fakeMqttStatusClient{}
	spy := &bambuSpyReporter{}

	cfg := ConnectionConfig{IP: "192.168.1.100", MqttPort: 8883}
	cred := Credential{AccessCode: "TESTCODE", Serial: "ABCD1234"}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- Subscribe(ctx, cfg, cred, "job-err", spy, newFakeMqttStatusFactory(fc), nil)
	}()

	time.Sleep(20 * time.Millisecond)

	printErr := uint32(99)
	fc.Feed(mustMarshalBambu(t, map[string]any{
		"print": map[string]any{
			"gcode_state":  "FAILED",
			"print_error":  printErr,
			"subtask_name": "bad_job.3mf",
		},
	}))

	time.Sleep(20 * time.Millisecond)
	cancel()
	<-done

	var fe *central.StatusReport
	for _, r := range spy.statusEvents() {
		if r.Event != nil && r.Event.Kind == "firmware_error" {
			r := r
			fe = &r
			break
		}
	}
	if fe == nil {
		t.Fatal("no firmware_error status-event found")
	}
	if fe.Event.ErrorCode != "99" {
		t.Errorf("errorCode: got %q want %q", fe.Event.ErrorCode, "99")
	}

	// Must also have a failed phase report.
	failedPhase := spy.find("failed")
	if failedPhase == nil {
		t.Fatal("no failed phase report")
	}
}

func TestSubscribe_OperatorCancel(t *testing.T) {
	fc := &fakeMqttStatusClient{}
	spy := &bambuSpyReporter{}

	cfg := ConnectionConfig{IP: "192.168.1.100", MqttPort: 8883}
	cred := Credential{AccessCode: "TESTCODE", Serial: "ABCD1234"}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- Subscribe(ctx, cfg, cred, "job-cancel", spy, newFakeMqttStatusFactory(fc), nil)
	}()

	time.Sleep(20 * time.Millisecond)

	// Send PAUSE first, then IDLE.
	fc.Feed(makePrintPayload(t, "PAUSE", map[string]any{"subtask_name": "job"}))
	time.Sleep(10 * time.Millisecond)
	fc.Feed(makePrintPayload(t, "IDLE", map[string]any{"subtask_name": "job"}))
	time.Sleep(20 * time.Millisecond)
	cancel()
	<-done

	var cancelled *central.StatusReport
	for _, r := range spy.statusEvents() {
		if r.Event != nil && r.Event.Kind == "cancelled" {
			r := r
			cancelled = &r
			break
		}
	}
	if cancelled == nil {
		t.Fatal("expected cancelled status-event from PAUSE→IDLE sequence")
	}
	if spy.find("failed") == nil {
		t.Fatal("expected failed phase report after operator cancel")
	}
}

func TestSubscribe_HmsWarning(t *testing.T) {
	fc := &fakeMqttStatusClient{}
	spy := &bambuSpyReporter{}

	cfg := ConnectionConfig{IP: "192.168.1.100", MqttPort: 8883}
	cred := Credential{AccessCode: "TESTCODE", Serial: "ABCD1234"}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- Subscribe(ctx, cfg, cred, "job-hms", spy, newFakeMqttStatusFactory(fc), nil)
	}()

	time.Sleep(20 * time.Millisecond)

	fc.Feed(mustMarshalBambu(t, map[string]any{
		"print": map[string]any{
			"gcode_state":  "RUNNING",
			"subtask_name": "job",
			"hms": []any{
				map[string]any{"attr": 0x03005000, "code": 0x07004000, "level": 1},
			},
		},
	}))

	time.Sleep(20 * time.Millisecond)
	cancel()
	<-done

	var warn *central.StatusReport
	for _, r := range spy.statusEvents() {
		if r.Event != nil && r.Event.Kind == "warning" {
			r := r
			warn = &r
			break
		}
	}
	if warn == nil {
		t.Fatal("expected warning status-event from HMS entry")
	}
	if warn.Event.ErrorCode != "0300-5000-0700-4000" {
		t.Errorf("HMS errorCode: got %q", warn.Event.ErrorCode)
	}
	if warn.Event.Severity != "warning" {
		t.Errorf("HMS severity: got %q want warning", warn.Event.Severity)
	}
}

// ---------------------------------------------------------------------------
// decodeBambuMessage (unit)
// ---------------------------------------------------------------------------

func TestDecodeBambuMessage_UnknownTopLevelKey(t *testing.T) {
	raw := []byte(`{"pushing":{"pushall":{"print":{"gcode_state":"RUNNING"}}}}`)
	last := ""
	intents := decodeBambuMessage(raw, &last, nil)
	// No top-level "print" key → 0 intents.
	if len(intents) != 0 {
		t.Errorf("expected 0 intents for non-top-level print, got %d", len(intents))
	}
}

func TestDecodeBambuMessage_InvalidJSON(t *testing.T) {
	last := ""
	intents := decodeBambuMessage([]byte(`not json`), &last, nil)
	if len(intents) != 0 {
		t.Errorf("expected 0 intents for invalid JSON, got %d", len(intents))
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func strPtr(s string) *string       { return &s }
func float64Ptr(f float64) *float64 { return &f }
