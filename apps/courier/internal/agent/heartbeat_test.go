package agent

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// discardLogger returns a slog.Logger that discards all output.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(noopWriter{}, nil))
}

type noopWriter struct{}

func (noopWriter) Write(p []byte) (int, error) { return len(p), nil }

// newTestServer creates an httptest.Server backed by the provided handler.
// It returns the server and a *central.Client pointed at it.
func newTestServer(t *testing.T, handler http.Handler) (*httptest.Server, *central.Client) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	client := central.New(srv.URL, "test-api-key", "2.0.0", nil)
	return srv, client
}

// okHeartbeatResponse encodes a standard successful heartbeat JSON body.
func okHeartbeatResponse(intervalSecs int, warning string) []byte {
	body := map[string]any{
		"ok":                         true,
		"server_version":             "2.0.0",
		"heartbeat_interval_seconds": intervalSecs,
		"warning":                    warning,
	}
	b, _ := json.Marshal(body)
	return b
}

// -----------------------------------------------------------------------------
// Test: initial heartbeat is sent immediately, then periodically.
// -----------------------------------------------------------------------------

func TestRunHeartbeat_SendsInitialAndPeriodic(t *testing.T) {
	var count atomic.Int32

	_, client := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/couriers/heartbeat" {
			http.NotFound(w, r)
			return
		}
		count.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(okHeartbeatResponse(0, ""))
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()

	interval := 30 * time.Millisecond

	err := run(ctx, client, interval, discardLogger())
	// Should exit with ctx.Err() (deadline exceeded).
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}

	// In 120ms with a 30ms interval we should fire: immediately (0ms), 30ms, 60ms, 90ms → ≥3.
	got := int(count.Load())
	if got < 3 {
		t.Errorf("expected at least 3 heartbeats in 120ms (30ms interval), got %d", got)
	}
}

// -----------------------------------------------------------------------------
// Test: server-returned interval is adopted.
// -----------------------------------------------------------------------------

func TestRunHeartbeat_AdoptsServerInterval(t *testing.T) {
	// First response asks the courier to use a 200ms interval.
	// We collect timestamps of each call.
	var timestamps []time.Time

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/couriers/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		timestamps = append(timestamps, time.Now())
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// Always return 50ms — the initial call adopts it; subsequent calls see no change.
		_, _ = w.Write(okHeartbeatResponse(0 /* use zero so only the test-interval matters */, ""))
	})

	// Override: first response returns a new interval of 50ms (expressed in
	// server seconds; but we'll test adoption by injecting a small duration
	// directly via the internals).
	// Instead, use the server-returned HeartbeatIntervalSeconds mechanism:
	callCount := 0
	_, client := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// First heartbeat: tell the client to tune to 1 second (we test the
		// adoption in the log/interval change path; actual timing is controlled
		// by the initial interval).
		if callCount == 1 {
			body := map[string]any{
				"ok":                         true,
				"server_version":             "2.0.0",
				"heartbeat_interval_seconds": 1,
			}
			b, _ := json.Marshal(body)
			_, _ = w.Write(b)
		} else {
			_, _ = w.Write(okHeartbeatResponse(0, ""))
		}
	}))

	// Start with a very short interval; after the first beat the interval
	// changes to 1s (1000ms) which is much longer than our window.
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()

	err := run(ctx, client, 20*time.Millisecond, discardLogger())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}

	// After the first beat sets interval to 1s, no further beats should fire
	// within an 80ms window. So exactly 1 heartbeat call expected.
	if callCount != 1 {
		t.Errorf("expected exactly 1 heartbeat call after interval adopted to 1s, got %d", callCount)
	}
}

// -----------------------------------------------------------------------------
// Test: transient 5xx is logged and loop continues; subsequent success works.
// -----------------------------------------------------------------------------

func TestRunHeartbeat_ContinuesOnTransientError(t *testing.T) {
	var count atomic.Int32

	_, client := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := count.Add(1)
		if n == 1 {
			// First call: return 500 (transient).
			http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
			return
		}
		// Subsequent calls: success.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(okHeartbeatResponse(0, ""))
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()

	err := run(ctx, client, 30*time.Millisecond, discardLogger())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded (loop kept running), got %v", err)
	}

	got := int(count.Load())
	// Should have at least 2 calls: the failed initial + at least one successful one.
	if got < 2 {
		t.Errorf("expected at least 2 heartbeat attempts, got %d", got)
	}
}

// -----------------------------------------------------------------------------
// Test: ErrVersionIncompatible causes immediate return (fatal).
// -----------------------------------------------------------------------------

func TestRunHeartbeat_ReturnsOnVersionIncompatible(t *testing.T) {
	_, client := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		body := map[string]any{
			"error":          "version-incompatible",
			"server_version": "3.0.0",
			"action":         "upgrade",
		}
		b, _ := json.Marshal(body)
		_, _ = w.Write(b)
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := run(ctx, client, 30*time.Millisecond, discardLogger())

	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !errors.Is(err, central.ErrVersionIncompatible) {
		t.Errorf("expected errors.Is(err, ErrVersionIncompatible), got: %v", err)
	}

	// Verify the carried ServerVersion via errors.As.
	var ve *central.VersionIncompatibleError
	if !errors.As(err, &ve) {
		t.Fatalf("expected *central.VersionIncompatibleError via errors.As, got: %T", err)
	}
	if ve.ServerVersion != "3.0.0" {
		t.Errorf("expected ServerVersion=3.0.0, got %q", ve.ServerVersion)
	}
}

// -----------------------------------------------------------------------------
// Test: ctx cancel causes clean exit.
// -----------------------------------------------------------------------------

func TestRunHeartbeat_ExitsOnContextCancel(t *testing.T) {
	_, client := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(okHeartbeatResponse(0, ""))
	}))

	ctx, cancel := context.WithCancel(context.Background())

	// Cancel after a brief delay.
	go func() {
		time.Sleep(40 * time.Millisecond)
		cancel()
	}()

	err := run(ctx, client, 10*time.Millisecond, discardLogger())
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// Test: intervalSeconds <= 0 defaults to 30 (via exported RunHeartbeat).
// -----------------------------------------------------------------------------

func TestRunHeartbeat_DefaultIntervalOnZeroOrNegative(t *testing.T) {
	// We can't easily test the 30-second default in a fast test, but we can
	// verify that RunHeartbeat doesn't panic and that it sends at least one
	// heartbeat before cancellation.
	var count atomic.Int32

	_, client := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(okHeartbeatResponse(0, ""))
	}))

	ctx, cancel := context.WithCancel(context.Background())
	// Cancel almost immediately — we just want to confirm it doesn't panic and
	// fires the initial heartbeat.
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	// Use 0 — should default to 30s internally, but the initial beat fires before
	// any timer, so we'll always see at least 1 call.
	err := RunHeartbeat(ctx, client, 0, discardLogger())
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got %v", err)
	}
	if count.Load() < 1 {
		t.Error("expected at least 1 heartbeat even with default interval")
	}
}

// -----------------------------------------------------------------------------
// Test: warning from server is handled without error.
// -----------------------------------------------------------------------------

func TestRunHeartbeat_WarningFromServer(t *testing.T) {
	_, client := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(okHeartbeatResponse(0, "minor-version-mismatch"))
	}))

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	err := run(ctx, client, 10*time.Millisecond, discardLogger())
	// Warning should NOT cause a fatal return — context cancel is the only exit.
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled (warning is non-fatal), got %v", err)
	}
}
