package chitu

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// ---------------------------------------------------------------------------
// ParseM27Reply — pure unit tests
// ---------------------------------------------------------------------------

func TestParseM27Reply(t *testing.T) {
	cases := []struct {
		line string
		want M27Reply
		ok   bool
	}{
		{"Print: 12345/100000", M27Reply{IsPrinting: true, BytesPrinted: 12345, TotalBytes: 100000}, true},
		{"Print: 0/100000", M27Reply{IsPrinting: true, BytesPrinted: 0, TotalBytes: 100000}, true},
		{"Print: 100000/100000", M27Reply{IsPrinting: true, BytesPrinted: 100000, TotalBytes: 100000}, true},
		{"  print: 5/10  ", M27Reply{IsPrinting: true, BytesPrinted: 5, TotalBytes: 10}, true},
		{"Not currently printing", M27Reply{IsPrinting: false}, true},
		{"NOT CURRENTLY PRINTING", M27Reply{IsPrinting: false}, true},
		{"  Not currently printing  ", M27Reply{IsPrinting: false}, true},
		{"ok", M27Reply{}, false},
		{"T:210", M27Reply{}, false},
		{"", M27Reply{}, false},
	}

	for _, tc := range cases {
		got, ok := ParseM27Reply(tc.line)
		if ok != tc.ok {
			t.Errorf("ParseM27Reply(%q): ok=%v, want=%v", tc.line, ok, tc.ok)
			continue
		}
		if ok && (got.IsPrinting != tc.want.IsPrinting ||
			got.BytesPrinted != tc.want.BytesPrinted ||
			got.TotalBytes != tc.want.TotalBytes) {
			t.Errorf("ParseM27Reply(%q): got %+v, want %+v", tc.line, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// ComputeOfflineInterval — pure unit tests
// ---------------------------------------------------------------------------

func TestComputeOfflineInterval(t *testing.T) {
	cases := []struct {
		failures int
		want     time.Duration
	}{
		{5, 60 * time.Second},              // at threshold: 2^0 * 60s
		{6, 120 * time.Second},             // 2^1 * 60s
		{7, 240 * time.Second},             // 2^2 * 60s
		{8, 300 * time.Second},             // cap: 5 min
		{100, 300 * time.Second},           // cap: 5 min
		{0, 60 * time.Second},              // below threshold: floor
		{4, 60 * time.Second},              // below threshold: floor
	}

	for _, tc := range cases {
		got := ComputeOfflineInterval(tc.failures)
		if got != tc.want {
			t.Errorf("ComputeOfflineInterval(%d): got %v, want %v", tc.failures, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// NextState — pure state transition tests
// ---------------------------------------------------------------------------

func TestNextState(t *testing.T) {
	printing := M27Reply{IsPrinting: true, BytesPrinted: 1000, TotalBytes: 100000}
	near := M27Reply{IsPrinting: true, BytesPrinted: 91000, TotalBytes: 100000}
	notPrinting := M27Reply{IsPrinting: false}
	zero := M27Reply{IsPrinting: true, BytesPrinted: 0, TotalBytes: 100000}
	zeroTotal := M27Reply{IsPrinting: true, BytesPrinted: 0, TotalBytes: 0}

	cases := []struct {
		name    string
		current PollingState
		reply   M27Reply
		ok      bool
		want    PollingState
	}{
		// From IDLE.
		{"IDLE + printing→PRINTING", StateIdle, printing, true, StatePrinting},
		{"IDLE + near→NEAR_COMPLETION", StateIdle, near, true, StateNearCompletion},
		{"IDLE + not-printing→IDLE", StateIdle, notPrinting, true, StateIdle},
		{"IDLE + zeroBytes→IDLE", StateIdle, zero, true, StateIdle},
		{"IDLE + unknown→IDLE", StateIdle, M27Reply{}, false, StateIdle},

		// From PRINTING.
		{"PRINTING + printing→PRINTING", StatePrinting, printing, true, StatePrinting},
		{"PRINTING + near→NEAR_COMPLETION", StatePrinting, near, true, StateNearCompletion},
		{"PRINTING + not-printing→JUST_FINISHED", StatePrinting, notPrinting, true, StateJustFinished},
		{"PRINTING + unknown→PRINTING", StatePrinting, M27Reply{}, false, StatePrinting},

		// From NEAR_COMPLETION.
		{"NEAR_COMPLETION + near→NEAR_COMPLETION", StateNearCompletion, near, true, StateNearCompletion},
		{"NEAR_COMPLETION + not-printing→JUST_FINISHED", StateNearCompletion, notPrinting, true, StateJustFinished},
		{"NEAR_COMPLETION + printing→PRINTING", StateNearCompletion, printing, true, StatePrinting},

		// From JUST_FINISHED.
		{"JUST_FINISHED + not-printing→JUST_FINISHED", StateJustFinished, notPrinting, true, StateJustFinished},
		{"JUST_FINISHED + printing→PRINTING", StateJustFinished, printing, true, StatePrinting},
		{"JUST_FINISHED + zero bytes→JUST_FINISHED", StateJustFinished, zero, true, StateJustFinished},

		// From OFFLINE — always stay (loop handles exit).
		{"OFFLINE + printing→OFFLINE", StateOffline, printing, true, StateOffline},
		{"OFFLINE + not-printing→OFFLINE", StateOffline, notPrinting, true, StateOffline},
		{"OFFLINE + unknown→OFFLINE", StateOffline, M27Reply{}, false, StateOffline},

		// Zero total bytes — stay in current.
		{"PRINTING + zeroTotal→PRINTING", StatePrinting, zeroTotal, true, StatePrinting},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := NextState(tc.current, tc.reply, tc.ok)
			if got != tc.want {
				t.Errorf("NextState(%v, %+v, ok=%v) = %v, want %v",
					tc.current, tc.reply, tc.ok, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// runLoop — injected poll + sleep, full state machine coverage
// ---------------------------------------------------------------------------

// mockReporter records all ReportStatus calls.
type mockReporter struct {
	mu      sync.Mutex
	reports []central.StatusReport
}

func (m *mockReporter) ReportStatus(_ context.Context, r central.StatusReport) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reports = append(m.reports, r)
	return nil
}

func (m *mockReporter) find(phase string) []central.StatusReport {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []central.StatusReport
	for _, r := range m.reports {
		if r.Phase == phase {
			out = append(out, r)
		}
	}
	return out
}

func (m *mockReporter) countEvents(kind string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, r := range m.reports {
		if r.Phase == "status-event" && r.Event != nil && r.Event.Kind == kind {
			n++
		}
	}
	return n
}

// mockPollFn builds a PollFunc that returns replies from the script.
// After the script is exhausted it returns (zero, false).
type pollScript struct {
	mu      sync.Mutex
	replies []struct {
		reply M27Reply
		ok    bool
	}
	idx int
}

func newPollScript(entries ...struct {
	reply M27Reply
	ok    bool
}) *pollScript {
	ps := &pollScript{}
	ps.replies = entries
	return ps
}

func (ps *pollScript) poll() (M27Reply, bool) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.idx >= len(ps.replies) {
		return M27Reply{}, false
	}
	e := ps.replies[ps.idx]
	ps.idx++
	return e.reply, e.ok
}

// noopSleep ignores duration (test uses a script of deterministic replies).
func noopSleep(_ time.Duration) {}

// cancelAfterN returns a context that is cancelled after the poll script
// index reaches n.
func cancelAfterNPolls(ps *pollScript, n int) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for {
			ps.mu.Lock()
			idx := ps.idx
			ps.mu.Unlock()
			if idx >= n {
				cancel()
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	return ctx, cancel
}

func TestRunLoop_IdleToPrintingToJustFinished_CompletedEmittedOnce(t *testing.T) {
	printing := struct {
		reply M27Reply
		ok    bool
	}{M27Reply{IsPrinting: true, BytesPrinted: 50_000, TotalBytes: 100_000}, true}
	near := struct {
		reply M27Reply
		ok    bool
	}{M27Reply{IsPrinting: true, BytesPrinted: 95_000, TotalBytes: 100_000}, true}
	notPrinting := struct {
		reply M27Reply
		ok    bool
	}{M27Reply{IsPrinting: false}, true}

	// Script: idle→printing→near→justFinished (not-printing).
	// Then several more not-printing polls while JUST_FINISHED.
	ps := newPollScript(printing, near, notPrinting, notPrinting, notPrinting)
	reporter := &mockReporter{}

	ctx, cancel := cancelAfterNPolls(ps, 5)
	defer cancel()

	cfg := ConnectionConfig{IP: "127.0.0.1", Port: 3000, StartPrint: true, StageTimeoutMs: 60_000}
	_ = runLoop(ctx, cfg, "job-1", reporter, nil, ps.poll, noopSleep)

	// completed must be emitted exactly once.
	if n := reporter.countEvents("completed"); n != 1 {
		t.Errorf("completed events: want 1, got %d", n)
	}
	// completed phase report must appear.
	if n := len(reporter.find("completed")); n != 1 {
		t.Errorf("completed phase reports: want 1, got %d", n)
	}
	// progress events must have appeared.
	if n := reporter.countEvents("progress"); n < 1 {
		t.Errorf("progress events: want ≥1, got %d", n)
	}
}

func TestRunLoop_CompletedEmittedOnlyOnce_NotTwice(t *testing.T) {
	// Transition to JUST_FINISHED twice from PRINTING → only 1 completed.
	printing := struct{ reply M27Reply; ok bool }{M27Reply{IsPrinting: true, BytesPrinted: 1000, TotalBytes: 10000}, true}
	notPrinting := struct{ reply M27Reply; ok bool }{M27Reply{IsPrinting: false}, true}

	ps := newPollScript(printing, notPrinting, printing, notPrinting)
	reporter := &mockReporter{}

	ctx, cancel := cancelAfterNPolls(ps, 4)
	defer cancel()

	cfg := ConnectionConfig{IP: "127.0.0.1", Port: 3000, StartPrint: true, StageTimeoutMs: 60_000}
	_ = runLoop(ctx, cfg, "job-2", reporter, nil, ps.poll, noopSleep)

	// completed must be emitted exactly once regardless of how many
	// PRINTING→JUST_FINISHED transitions occur.
	if n := reporter.countEvents("completed"); n != 1 {
		t.Errorf("completed events: want 1, got %d", n)
	}
}

func TestRunLoop_OfflineBackoff_RecoverToIdle(t *testing.T) {
	fail := struct{ reply M27Reply; ok bool }{M27Reply{}, false}
	success := struct{ reply M27Reply; ok bool }{M27Reply{IsPrinting: false}, true}

	// 5 consecutive failures → OFFLINE; then 1 success → back to IDLE.
	ps := newPollScript(fail, fail, fail, fail, fail, success)
	reporter := &mockReporter{}

	ctx, cancel := cancelAfterNPolls(ps, 6)
	defer cancel()

	cfg := ConnectionConfig{IP: "127.0.0.1", Port: 3000, StartPrint: true, StageTimeoutMs: 60_000}
	_ = runLoop(ctx, cfg, "job-3", reporter, nil, ps.poll, noopSleep)

	// unreachable event must have been emitted on entry to OFFLINE.
	if n := reporter.countEvents("unreachable"); n < 1 {
		t.Errorf("unreachable events: want ≥1, got %d", n)
	}
}

func TestRunLoop_NearCompletion_Over90Pct(t *testing.T) {
	// 91% progress → should enter NEAR_COMPLETION.
	near := struct{ reply M27Reply; ok bool }{M27Reply{IsPrinting: true, BytesPrinted: 91_000, TotalBytes: 100_000}, true}
	notPrinting := struct{ reply M27Reply; ok bool }{M27Reply{IsPrinting: false}, true}

	ps := newPollScript(near, notPrinting)
	reporter := &mockReporter{}

	ctx, cancel := cancelAfterNPolls(ps, 2)
	defer cancel()

	cfg := ConnectionConfig{IP: "127.0.0.1", Port: 3000}
	_ = runLoop(ctx, cfg, "job-4", reporter, nil, ps.poll, noopSleep)

	// Should emit completed (NEAR_COMPLETION → JUST_FINISHED).
	if n := reporter.countEvents("completed"); n != 1 {
		t.Errorf("completed events: want 1, got %d", n)
	}
}

func TestRunLoop_NoCompletedFromIdle(t *testing.T) {
	// IDLE → not-printing (printer was never printing from our perspective).
	// Must NOT emit completed.
	notPrinting := struct{ reply M27Reply; ok bool }{M27Reply{IsPrinting: false}, true}

	ps := newPollScript(notPrinting, notPrinting, notPrinting)
	reporter := &mockReporter{}

	ctx, cancel := cancelAfterNPolls(ps, 3)
	defer cancel()

	cfg := ConnectionConfig{IP: "127.0.0.1", Port: 3000}
	_ = runLoop(ctx, cfg, "job-5", reporter, nil, ps.poll, noopSleep)

	if n := reporter.countEvents("completed"); n != 0 {
		t.Errorf("completed events from IDLE path: want 0, got %d", n)
	}
}

// ---------------------------------------------------------------------------
// runLoopWithNotify — notifyPrinting forces IDLE→PRINTING
// ---------------------------------------------------------------------------

func TestRunLoopWithNotify_ForcesIdleToPrinting(t *testing.T) {
	printing := struct{ reply M27Reply; ok bool }{M27Reply{IsPrinting: true, BytesPrinted: 5000, TotalBytes: 10000}, true}
	notPrinting := struct{ reply M27Reply; ok bool }{M27Reply{IsPrinting: false}, true}

	ps := newPollScript(printing, notPrinting)
	reporter := &mockReporter{}

	notifyCh := make(chan struct{}, 1)
	notifyCh <- struct{}{} // pre-send notify before loop starts

	ctx, cancel := cancelAfterNPolls(ps, 2)
	defer cancel()

	cfg := ConnectionConfig{IP: "127.0.0.1", Port: 3000}
	_ = runLoopWithNotify(ctx, cfg, "job-notify", reporter, nil, ps.poll, noopSleep, notifyCh)

	// Should see progress since state entered PRINTING.
	if n := reporter.countEvents("progress"); n < 1 {
		t.Errorf("progress events: want ≥1, got %d", n)
	}
}

// ---------------------------------------------------------------------------
// printers.Reporter interface compliance
// ---------------------------------------------------------------------------

var _ printers.Reporter = (*mockReporter)(nil)
