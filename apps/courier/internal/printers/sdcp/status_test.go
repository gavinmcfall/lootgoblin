// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package sdcp

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// ---------------------------------------------------------------------------
// Pure unit tests — mapSdcpStatus
// ---------------------------------------------------------------------------

func TestMapSdcpStatus_AllValues(t *testing.T) {
	cases := []struct {
		in      int
		want    sdcpStatusKind
		wantOK  bool
		comment string
	}{
		{0, "", false, "IDLE — no event"},
		{1, sdcpProgress, true, "PRINTING"},
		{2, sdcpCompleted, true, "COMPLETE"},
		{3, sdcpFirmwareError, true, "FAIL"},
		{4, "", false, "LIFTING — no event"},
		{5, "", false, "PAUSING — no event"},
		{6, "", false, "PAUSED — no event"},
		{7, "", false, "reserved — no event"},
		{8, sdcpCancelled, true, "STOPPED — operator cancel"},
		{9, sdcpCompleted, true, "COMPLETE alt"},
		{10, "", false, "FILE_CHECKING — no event"},
		{99, "", false, "unknown — no event"},
	}

	for _, tc := range cases {
		got, ok := mapSdcpStatus(tc.in)
		if ok != tc.wantOK {
			t.Errorf("status=%d (%s): wantOK=%v got=%v", tc.in, tc.comment, tc.wantOK, ok)
			continue
		}
		if ok && got != tc.want {
			t.Errorf("status=%d (%s): want kind=%s got=%s", tc.in, tc.comment, tc.want, got)
		}
	}
}

// ---------------------------------------------------------------------------
// Pure unit tests — buildSdcpIntents
// ---------------------------------------------------------------------------

func makePrintInfoPayload(status int, currentLayer, totalLayer *int, remainTime *int, errorReason any, filename string) sdcpStatusPayload {
	pi := &sdcpPrintInfo{
		Status: &status,
	}
	if currentLayer != nil {
		v := *currentLayer
		pi.CurrentLayer = &v
	}
	if totalLayer != nil {
		v := *totalLayer
		pi.TotalLayer = &v
	}
	if remainTime != nil {
		v := *remainTime
		pi.RemainTime = &v
	}
	if errorReason != nil {
		pi.ErrorStatusReason = errorReason
	}
	if filename != "" {
		pi.Filename = &filename
	}
	return sdcpStatusPayload{
		Topic: "sdcp/status/TEST",
		Status: &sdcpStatusObj{
			PrintInfo: pi,
		},
	}
}

func intPtr(v int) *int { return &v }

func TestBuildSdcpIntents_Progress(t *testing.T) {
	payload := makePrintInfoPayload(1, intPtr(50), intPtr(200), intPtr(3600), nil, "model.ctb")
	intents := buildSdcpIntents(payload, sdcpProgress, time.Now())

	if len(intents) != 1 {
		t.Fatalf("want 1 intent (no terminal), got %d", len(intents))
	}
	si := intents[0]
	if !si.isStatusEvent {
		t.Error("want isStatusEvent=true")
	}
	if si.eventKind != sdcpProgress {
		t.Errorf("want eventKind=progress, got %s", si.eventKind)
	}
	if si.remoteJobRef != "model.ctb" {
		t.Errorf("want remoteJobRef=model.ctb, got %q", si.remoteJobRef)
	}
	// progressPct = round(50/200*100) = 25
	if si.progressPct == nil || *si.progressPct != 25 {
		t.Errorf("want progressPct=25, got %v", si.progressPct)
	}
	if si.layerNum == nil || *si.layerNum != 50 {
		t.Errorf("want layerNum=50, got %v", si.layerNum)
	}
	if si.totalLayers == nil || *si.totalLayers != 200 {
		t.Errorf("want totalLayers=200, got %v", si.totalLayers)
	}
	// remainingMin = round(3600/60) = 60
	if si.remainingMin == nil || *si.remainingMin != 60 {
		t.Errorf("want remainingMin=60, got %v", si.remainingMin)
	}
}

func TestBuildSdcpIntents_Completed(t *testing.T) {
	payload := makePrintInfoPayload(2, nil, nil, nil, nil, "done.ctb")
	intents := buildSdcpIntents(payload, sdcpCompleted, time.Now())

	if len(intents) != 2 {
		t.Fatalf("want 2 intents (status-event + completed), got %d", len(intents))
	}
	si := intents[0]
	if si.eventKind != sdcpCompleted {
		t.Errorf("want eventKind=completed, got %s", si.eventKind)
	}
	ci := intents[1]
	if !ci.isCompleted {
		t.Error("want isCompleted=true")
	}
}

func TestBuildSdcpIntents_FirmwareError_StringReason(t *testing.T) {
	payload := makePrintInfoPayload(3, nil, nil, nil, "MOTOR_FAILURE", "")
	intents := buildSdcpIntents(payload, sdcpFirmwareError, time.Now())

	if len(intents) != 2 {
		t.Fatalf("want 2 intents, got %d", len(intents))
	}
	si := intents[0]
	if si.eventKind != sdcpFirmwareError {
		t.Errorf("want eventKind=firmware_error, got %s", si.eventKind)
	}
	if si.errorCode != "MOTOR_FAILURE" {
		t.Errorf("want errorCode=MOTOR_FAILURE, got %q", si.errorCode)
	}
	fi := intents[1]
	if !fi.isFailed {
		t.Error("want isFailed=true")
	}
	if fi.failReason != "rejected" {
		t.Errorf("want failReason=rejected, got %q", fi.failReason)
	}
	if fi.failDetails != "MOTOR_FAILURE" {
		t.Errorf("want failDetails=MOTOR_FAILURE, got %q", fi.failDetails)
	}
}

func TestBuildSdcpIntents_FirmwareError_NumericReason(t *testing.T) {
	payload := makePrintInfoPayload(3, nil, nil, nil, float64(12), "")
	intents := buildSdcpIntents(payload, sdcpFirmwareError, time.Now())

	if len(intents) != 2 {
		t.Fatalf("want 2 intents, got %d", len(intents))
	}
	if intents[0].errorCode != "12" {
		t.Errorf("want errorCode='12', got %q", intents[0].errorCode)
	}
}

func TestBuildSdcpIntents_FirmwareError_NoReason(t *testing.T) {
	payload := makePrintInfoPayload(3, nil, nil, nil, nil, "")
	intents := buildSdcpIntents(payload, sdcpFirmwareError, time.Now())

	if intents[0].errorCode != "" {
		t.Errorf("want empty errorCode, got %q", intents[0].errorCode)
	}
	// failDetails falls back to "firmware error".
	if intents[1].failDetails != "firmware error" {
		t.Errorf("want failDetails='firmware error', got %q", intents[1].failDetails)
	}
}

func TestBuildSdcpIntents_Cancelled(t *testing.T) {
	payload := makePrintInfoPayload(8, nil, nil, nil, nil, "job.ctb")
	intents := buildSdcpIntents(payload, sdcpCancelled, time.Now())

	if len(intents) != 2 {
		t.Fatalf("want 2 intents, got %d", len(intents))
	}
	if intents[0].eventKind != sdcpCancelled {
		t.Errorf("want eventKind=cancelled, got %s", intents[0].eventKind)
	}
	if !intents[1].isFailed {
		t.Error("want isFailed=true on second intent")
	}
	if intents[1].failDetails != "cancelled" {
		t.Errorf("want failDetails=cancelled, got %q", intents[1].failDetails)
	}
}

// ---------------------------------------------------------------------------
// Cmd 128 JSON shape test
// ---------------------------------------------------------------------------

func TestBuildStartPrintMessage_Shape(t *testing.T) {
	msg, err := buildStartPrintMessage("BOARD01", "model.ctb", 5, "id-uuid", "req-uuid", 1700000000)
	if err != nil {
		t.Fatalf("buildStartPrintMessage: %v", err)
	}

	var p startPrintPayload
	if err := json.Unmarshal(msg, &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if p.ID != "id-uuid" {
		t.Errorf("Id: want id-uuid, got %q", p.ID)
	}
	if p.Topic != "sdcp/request/BOARD01" {
		t.Errorf("Topic: want sdcp/request/BOARD01, got %q", p.Topic)
	}
	if p.Data.Cmd != 128 {
		t.Errorf("Cmd: want 128, got %d", p.Data.Cmd)
	}
	if p.Data.Data.Filename != "model.ctb" {
		t.Errorf("Filename: want model.ctb, got %q", p.Data.Data.Filename)
	}
	if p.Data.Data.StartLayer != 5 {
		t.Errorf("StartLayer: want 5, got %d", p.Data.Data.StartLayer)
	}
	if p.Data.RequestID != "req-uuid" {
		t.Errorf("RequestID: want req-uuid, got %q", p.Data.RequestID)
	}
	if p.Data.MainboardID != "BOARD01" {
		t.Errorf("MainboardID: want BOARD01, got %q", p.Data.MainboardID)
	}
	if p.Data.TimeStamp != 1700000000 {
		t.Errorf("TimeStamp: want 1700000000, got %d", p.Data.TimeStamp)
	}
	if p.Data.From != 0 {
		t.Errorf("From: want 0, got %d", p.Data.From)
	}
}

// TestStartPrintWithDialer_OnWireFilenameIsBare exercises the integration path
// startPrint → startPrintWithDialer → the actual JSON written to the socket,
// and asserts the on-wire Cmd 128 Data.Data.Filename is the BARE filename
// (no "/local/" prefix), matching Node's startSdcpPrint. This guards against a
// regression where the dispatch result's remoteFilename prefix leaks onto the
// wire field.
func TestStartPrintWithDialer_OnWireFilenameIsBare(t *testing.T) {
	conn := newFakeWsConn() // no read frames; startPrint only writes then closes
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030, StartLayer: 3}

	res := startPrintWithDialer(bg(), cfg, "model.ctb", "id-1", "req-1", 5000, nil,
		func(_ string) (wsConn, error) { return conn, nil })
	if !res.OK {
		t.Fatalf("startPrintWithDialer: want OK, got reason=%s details=%s", res.Reason, res.Details)
	}

	written := conn.Written()
	if len(written) != 1 {
		t.Fatalf("want exactly 1 message written (Cmd 128), got %d", len(written))
	}

	var p startPrintPayload
	if err := json.Unmarshal(written[0], &p); err != nil {
		t.Fatalf("on-wire payload is not valid JSON: %v", err)
	}
	if p.Data.Cmd != 128 {
		t.Errorf("Cmd: want 128, got %d", p.Data.Cmd)
	}
	// The critical assertion: bare filename on the wire, NOT "/local/model.ctb".
	if p.Data.Data.Filename != "model.ctb" {
		t.Errorf("on-wire Filename: want bare \"model.ctb\", got %q", p.Data.Data.Filename)
	}
	if p.Data.Data.StartLayer != 3 {
		t.Errorf("StartLayer: want 3, got %d", p.Data.Data.StartLayer)
	}
	if p.Topic != "sdcp/request/BOARD01" {
		t.Errorf("Topic: want sdcp/request/BOARD01, got %q", p.Topic)
	}
}

// ---------------------------------------------------------------------------
// Spy reporter (shared with status integration tests)
// ---------------------------------------------------------------------------

type spyReporter struct {
	mu      sync.Mutex
	reports []central.StatusReport
}

func (s *spyReporter) ReportStatus(_ context.Context, r central.StatusReport) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reports = append(s.reports, r)
	return nil
}

func (s *spyReporter) all() []central.StatusReport {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]central.StatusReport, len(s.reports))
	copy(cp, s.reports)
	return cp
}

func (s *spyReporter) firstByPhase(phase string) (central.StatusReport, bool) {
	for _, r := range s.all() {
		if r.Phase == phase {
			return r, true
		}
	}
	return central.StatusReport{}, false
}

// Satisfy printers.Reporter interface.
var _ printers.Reporter = (*spyReporter)(nil)

// ---------------------------------------------------------------------------
// Fake wsConn for status subscriber tests
// ---------------------------------------------------------------------------

type fakeWsConn struct {
	mu      sync.Mutex
	frames  [][]byte
	pos     int
	blockCh chan struct{}
	written [][]byte
}

func newFakeWsConn(frames ...[]byte) *fakeWsConn {
	return &fakeWsConn{frames: frames}
}

func newBlockingWsConn(frames ...[]byte) *fakeWsConn {
	return &fakeWsConn{frames: frames, blockCh: make(chan struct{})}
}

func (f *fakeWsConn) Unblock() {
	f.mu.Lock()
	ch := f.blockCh
	f.blockCh = nil
	f.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func (f *fakeWsConn) ReadMessage() ([]byte, error) {
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
		return nil, errors.New("fake ws: closed")
	}
	return nil, errors.New("fake ws: EOF")
}

func (f *fakeWsConn) WriteMessage(msg []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := make([]byte, len(msg))
	copy(cp, msg)
	f.written = append(f.written, cp)
	return nil
}

func (f *fakeWsConn) Close() error { return nil }

func (f *fakeWsConn) Written() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := make([][]byte, len(f.written))
	copy(cp, f.written)
	return cp
}

// ---------------------------------------------------------------------------
// Frame builder helpers
// ---------------------------------------------------------------------------

func makeStatusFrame(mainboardID string, status int, currentLayer, totalLayer *int, remainTime *int, filename string, errorReason any) []byte {
	pi := map[string]any{
		"Status": status,
	}
	if currentLayer != nil {
		pi["CurrentLayer"] = *currentLayer
	}
	if totalLayer != nil {
		pi["TotalLayer"] = *totalLayer
	}
	if remainTime != nil {
		pi["RemainTime"] = *remainTime
	}
	if filename != "" {
		pi["Filename"] = filename
	}
	if errorReason != nil {
		pi["ErrorStatusReason"] = errorReason
	}
	frame := map[string]any{
		"Topic": "sdcp/status/" + mainboardID,
		"Status": map[string]any{
			"PrintInfo": pi,
		},
	}
	b, _ := json.Marshal(frame)
	return b
}

// ---------------------------------------------------------------------------
// sendSdcpIntent unit tests
// ---------------------------------------------------------------------------

func TestSendSdcpIntent_StatusEvent_Progress(t *testing.T) {
	spy := &spyReporter{}
	pct := float64(42)
	layer := 84
	total := 200
	intent := sdcpReportIntent{
		isStatusEvent: true,
		eventKind:     sdcpProgress,
		remoteJobRef:  "model.ctb",
		progressPct:   &pct,
		layerNum:      &layer,
		totalLayers:   &total,
		rawPayload:    nil,
		occurredAt:    time.Now(),
	}
	err := sendSdcpIntent(context.Background(), spy, "job1", intent, nil)
	if err != nil {
		t.Fatalf("sendSdcpIntent: %v", err)
	}
	r, ok := spy.firstByPhase("status-event")
	if !ok {
		t.Fatal("expected status-event report")
	}
	if r.Event == nil {
		t.Fatal("event is nil")
	}
	if r.Event.Kind != "progress" {
		t.Errorf("kind: want progress, got %q", r.Event.Kind)
	}
	if r.Event.ProgressPct == nil || *r.Event.ProgressPct != 42 {
		t.Errorf("progressPct: want 42, got %v", r.Event.ProgressPct)
	}
	if r.Event.LayerNum == nil || *r.Event.LayerNum != 84 {
		t.Errorf("layerNum: want 84, got %v", r.Event.LayerNum)
	}
}

func TestSendSdcpIntent_Completed_NoMaterials(t *testing.T) {
	spy := &spyReporter{}
	err := sendSdcpIntent(context.Background(), spy, "job2", sdcpReportIntent{isCompleted: true}, nil)
	if err != nil {
		t.Fatalf("sendSdcpIntent: %v", err)
	}
	r, ok := spy.firstByPhase("completed")
	if !ok {
		t.Fatal("expected completed report")
	}
	if len(r.MaterialsUsed) != 0 {
		t.Errorf("SDCP completed should have no materials_used, got %v", r.MaterialsUsed)
	}
}

func TestSendSdcpIntent_Failed(t *testing.T) {
	spy := &spyReporter{}
	err := sendSdcpIntent(context.Background(), spy, "job3", sdcpReportIntent{
		isFailed:    true,
		failReason:  "rejected",
		failDetails: "cancelled",
	}, nil)
	if err != nil {
		t.Fatalf("sendSdcpIntent: %v", err)
	}
	r, ok := spy.firstByPhase("failed")
	if !ok {
		t.Fatal("expected failed report")
	}
	if r.Reason != "rejected" {
		t.Errorf("reason: want rejected, got %q", r.Reason)
	}
	if r.Details != "cancelled" {
		t.Errorf("details: want cancelled, got %q", r.Details)
	}
}

// ---------------------------------------------------------------------------
// subscribeWithDialer integration tests
// ---------------------------------------------------------------------------

func TestSubscribeWithDialer_ProgressEvent_EndToEnd(t *testing.T) {
	frame := makeStatusFrame("BOARD01", 1, intPtr(10), intPtr(100), intPtr(1200), "cube.ctb", nil)
	conn := newFakeWsConn(frame)

	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_ = subscribeWithDialer(ctx, cfg, "jobA", spy, nil, func(_ string) (wsConn, error) {
		return conn, nil
	})

	r, ok := spy.firstByPhase("status-event")
	if !ok {
		t.Fatal("expected status-event")
	}
	if r.Event == nil || r.Event.Kind != "progress" {
		t.Errorf("want kind=progress, got %v", r.Event)
	}
	if r.Event.RemoteJobRef != "cube.ctb" {
		t.Errorf("remoteJobRef: want cube.ctb, got %q", r.Event.RemoteJobRef)
	}
	// progressPct = round(10/100*100) = 10
	if r.Event.ProgressPct == nil || *r.Event.ProgressPct != 10 {
		t.Errorf("progressPct: want 10, got %v", r.Event.ProgressPct)
	}
	// layerNum
	if r.Event.LayerNum == nil || *r.Event.LayerNum != 10 {
		t.Errorf("layerNum: want 10, got %v", r.Event.LayerNum)
	}
	// remainingMin = round(1200/60) = 20
	if r.Event.RemainingMin == nil || *r.Event.RemainingMin != 20 {
		t.Errorf("remainingMin: want 20, got %v", r.Event.RemainingMin)
	}
}

func TestSubscribeWithDialer_CompletedEvent_Status2(t *testing.T) {
	frame := makeStatusFrame("BOARD01", 2, nil, nil, nil, "done.ctb", nil)
	conn := newFakeWsConn(frame)
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_ = subscribeWithDialer(ctx, cfg, "jobB", spy, nil, func(_ string) (wsConn, error) {
		return conn, nil
	})

	_, ok := spy.firstByPhase("completed")
	if !ok {
		t.Fatal("expected completed phase report")
	}
	r, _ := spy.firstByPhase("status-event")
	if r.Event == nil || r.Event.Kind != "completed" {
		t.Errorf("want status-event kind=completed, got %v", r.Event)
	}
}

func TestSubscribeWithDialer_CompletedEvent_Status9(t *testing.T) {
	frame := makeStatusFrame("BOARD01", 9, nil, nil, nil, "done2.ctb", nil)
	conn := newFakeWsConn(frame)
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_ = subscribeWithDialer(ctx, cfg, "jobC", spy, nil, func(_ string) (wsConn, error) {
		return conn, nil
	})

	_, ok := spy.firstByPhase("completed")
	if !ok {
		t.Fatal("status 9 should emit completed")
	}
}

func TestSubscribeWithDialer_FirmwareError_Status3(t *testing.T) {
	frame := makeStatusFrame("BOARD01", 3, nil, nil, nil, "", "MOTOR_FAIL")
	conn := newFakeWsConn(frame)
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_ = subscribeWithDialer(ctx, cfg, "jobD", spy, nil, func(_ string) (wsConn, error) {
		return conn, nil
	})

	r, ok := spy.firstByPhase("status-event")
	if !ok {
		t.Fatal("expected status-event")
	}
	if r.Event.Kind != "firmware_error" {
		t.Errorf("want firmware_error, got %q", r.Event.Kind)
	}
	if r.Event.ErrorCode != "MOTOR_FAIL" {
		t.Errorf("errorCode: want MOTOR_FAIL, got %q", r.Event.ErrorCode)
	}
	_, hasFailed := spy.firstByPhase("failed")
	if !hasFailed {
		t.Error("firmware_error should also emit failed phase")
	}
}

func TestSubscribeWithDialer_Cancelled_Status8(t *testing.T) {
	frame := makeStatusFrame("BOARD01", 8, nil, nil, nil, "job.ctb", nil)
	conn := newFakeWsConn(frame)
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_ = subscribeWithDialer(ctx, cfg, "jobE", spy, nil, func(_ string) (wsConn, error) {
		return conn, nil
	})

	r, ok := spy.firstByPhase("status-event")
	if !ok {
		t.Fatal("expected status-event")
	}
	if r.Event.Kind != "cancelled" {
		t.Errorf("want cancelled, got %q", r.Event.Kind)
	}
	_, hasFailed := spy.firstByPhase("failed")
	if !hasFailed {
		t.Error("cancelled should also emit failed phase")
	}
}

func TestSubscribeWithDialer_Idle_Status0_NoEvent(t *testing.T) {
	frame := makeStatusFrame("BOARD01", 0, nil, nil, nil, "", nil)
	conn := newFakeWsConn(frame)
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_ = subscribeWithDialer(ctx, cfg, "jobF", spy, nil, func(_ string) (wsConn, error) {
		return conn, nil
	})

	if len(spy.all()) != 0 {
		t.Errorf("idle status should emit no events, got %d", len(spy.all()))
	}
}

func TestSubscribeWithDialer_WrongTopic_Filtered(t *testing.T) {
	// Frame on a different mainboardId topic — should be filtered out.
	frame, _ := json.Marshal(map[string]any{
		"Topic": "sdcp/status/WRONGBOARD",
		"Status": map[string]any{
			"PrintInfo": map[string]any{"Status": 1},
		},
	})
	conn := newFakeWsConn(frame)
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_ = subscribeWithDialer(ctx, cfg, "jobG", spy, nil, func(_ string) (wsConn, error) {
		return conn, nil
	})

	if len(spy.all()) != 0 {
		t.Errorf("wrong topic should be filtered, got %d reports", len(spy.all()))
	}
}

func TestSubscribeWithDialer_CtxCancel_CleanReturn(t *testing.T) {
	conn := newBlockingWsConn()
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- subscribeWithDialer(ctx, cfg, "jobH", spy, nil, func(_ string) (wsConn, error) {
			return conn, nil
		})
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

func TestSubscribeWithDialer_ReadError_ReturnsError(t *testing.T) {
	conn := newFakeWsConn() // no frames → immediate EOF
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	err := subscribeWithDialer(context.Background(), cfg, "jobI", spy, nil, func(_ string) (wsConn, error) {
		return conn, nil
	})
	if err == nil {
		t.Error("expected error on EOF, got nil")
	}
}

func TestSubscribeWithDialer_SendsSubscribeMessage(t *testing.T) {
	conn := newBlockingWsConn()
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD01", Port: 3030}
	spy := &spyReporter{}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_ = subscribeWithDialer(ctx, cfg, "jobJ", spy, nil, func(_ string) (wsConn, error) {
		return conn, nil
	})

	written := conn.Written()
	if len(written) == 0 {
		t.Fatal("expected subscribe message to be written on open")
	}

	// Verify it's valid JSON with Cmd=0.
	var msg map[string]any
	if err := json.Unmarshal(written[0], &msg); err != nil {
		t.Fatalf("subscribe message is not valid JSON: %v", err)
	}
	data, _ := msg["Data"].(map[string]any)
	if data == nil {
		t.Fatal("subscribe message has no Data field")
	}
	if cmd, _ := data["Cmd"].(float64); cmd != 0 {
		t.Errorf("Cmd: want 0, got %v", data["Cmd"])
	}
	if mbID, _ := data["MainboardID"].(string); mbID != "BOARD01" {
		t.Errorf("MainboardID: want BOARD01, got %q", mbID)
	}
}
