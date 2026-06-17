// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// artifactBytes is a small deterministic payload for tests.
var artifactBytes = []byte("hello, courier artifact")

// artifactSHA256 is the hex SHA-256 of artifactBytes.
var artifactSHA256 = func() string {
	h := sha256.Sum256(artifactBytes)
	return hex.EncodeToString(h[:])
}()

// buildClaimMux returns a ServeMux that wires up the three dispatch endpoints.
// Each func argument is called for its respective endpoint; nil means the
// endpoint is not expected and will 404.
func buildClaimMux(
	claimFn func(w http.ResponseWriter, r *http.Request),
	downloadFn func(w http.ResponseWriter, r *http.Request),
	statusFn func(w http.ResponseWriter, r *http.Request),
) http.Handler {
	mux := http.NewServeMux()
	if claimFn != nil {
		mux.HandleFunc("/api/v1/dispatch/claim", claimFn)
	}
	if downloadFn != nil {
		mux.HandleFunc("/api/v1/dispatch/artifact/", downloadFn)
	}
	if statusFn != nil {
		mux.HandleFunc("/api/v1/dispatch/status", statusFn)
	}
	return mux
}

// noJobClaimResponse encodes a { "job": null } claim response.
func noJobClaimResponse() []byte {
	b, _ := json.Marshal(map[string]any{"job": nil})
	return b
}

// jobClaimResponse encodes a full ClaimBundle JSON response.
func jobClaimResponse(jobID string) []byte {
	body := map[string]any{
		"job": map[string]any{
			"id":          jobID,
			"target_kind": "print",
			"target_id":   "printer-1",
			"loot_id":     "loot-1",
			"owner_id":    "owner-1",
		},
		"artifact": map[string]any{
			"job_id":       jobID,
			"size_bytes":   len(artifactBytes),
			"sha256":       artifactSHA256,
			"mime_type":    "model/3mf",
			"download_url": "/api/v1/dispatch/artifact/" + jobID,
		},
	}
	b, _ := json.Marshal(body)
	return b
}

// okStatusResponse encodes a { "ok": true } status response.
func okStatusResponse() []byte {
	b, _ := json.Marshal(map[string]any{"ok": true})
	return b
}

// ---------------------------------------------------------------------------
// Test: no-job response → backoff sleep, no handler call, exits on cancel.
// ---------------------------------------------------------------------------

func TestRunClaimLoop_NoJob_BackoffAndContinue(t *testing.T) {
	var claimCount atomic.Int32

	mux := buildClaimMux(
		func(w http.ResponseWriter, r *http.Request) {
			claimCount.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(noJobClaimResponse())
		},
		nil, nil,
	)

	_, client := newTestServer(t, mux)

	handlerCalled := false
	handle := JobHandler(func(_ context.Context, _ *central.ClaimBundle, _ string) error {
		handlerCalled = true
		return nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()

	// Use a very short base (5ms) so we can observe multiple polls quickly.
	err := runClaim(ctx, client, 5*time.Millisecond, t.TempDir(), handle, discardLogger())

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}
	if handlerCalled {
		t.Error("handler must not be called when no job is available")
	}
	// Backoff doubles each time, so we won't see tons of polls; at least 2 expected.
	if claimCount.Load() < 2 {
		t.Errorf("expected at least 2 claim polls, got %d", claimCount.Load())
	}
}

// ---------------------------------------------------------------------------
// Test: job available → artifact downloaded, SHA matches → handler called once.
// ---------------------------------------------------------------------------

func TestRunClaimLoop_JobAvailable_HandlerCalledWithVerifiedArtifact(t *testing.T) {
	const jobID = "job-abc"

	var claimCount atomic.Int32
	var handlerCallCount atomic.Int32
	var handlerBundle *central.ClaimBundle
	var handlerPath string

	mux := buildClaimMux(
		func(w http.ResponseWriter, r *http.Request) {
			n := claimCount.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			if n == 1 {
				// First poll: return a job.
				_, _ = w.Write(jobClaimResponse(jobID))
			} else {
				// Subsequent polls: no job (so the loop idles until cancel).
				_, _ = w.Write(noJobClaimResponse())
			}
		},
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-Artifact-SHA256", artifactSHA256)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(artifactBytes)
		},
		nil, // status not expected in the happy path
	)

	_, client := newTestServer(t, mux)

	tempDir := t.TempDir()

	handle := JobHandler(func(_ context.Context, bundle *central.ClaimBundle, artifactPath string) error {
		handlerCallCount.Add(1)
		handlerBundle = bundle
		handlerPath = artifactPath
		return nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	err := runClaim(ctx, client, 5*time.Millisecond, tempDir, handle, discardLogger())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}

	if handlerCallCount.Load() != 1 {
		t.Errorf("expected handler called exactly once, got %d", handlerCallCount.Load())
	}

	if handlerBundle == nil {
		t.Fatal("handler bundle must be non-nil")
	}
	if handlerBundle.Job.ID != jobID {
		t.Errorf("expected job ID %q, got %q", jobID, handlerBundle.Job.ID)
	}

	// Verify the artifact path contained the right bytes when the handler saw it.
	// (The file is removed after the handler returns — check it no longer exists.)
	if _, err := os.Stat(handlerPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("temp file %q should have been removed after handler returned, stat err=%v", handlerPath, err)
	}
}

// ---------------------------------------------------------------------------
// Test: artifact file contents are correct before deletion.
// ---------------------------------------------------------------------------

func TestRunClaimLoop_ArtifactFileContentsCorrect(t *testing.T) {
	const jobID = "job-content"
	var capturedBytes []byte

	mux := buildClaimMux(
		func(w http.ResponseWriter, r *http.Request) {
			if capturedBytes != nil {
				// Already handled — serve no-job.
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(noJobClaimResponse())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(jobClaimResponse(jobID))
		},
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-Artifact-SHA256", artifactSHA256)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(artifactBytes)
		},
		nil,
	)

	_, client := newTestServer(t, mux)

	handle := JobHandler(func(_ context.Context, _ *central.ClaimBundle, artifactPath string) error {
		var err error
		capturedBytes, err = os.ReadFile(artifactPath)
		return err
	})

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	_ = runClaim(ctx, client, 5*time.Millisecond, t.TempDir(), handle, discardLogger())

	if !bytes.Equal(capturedBytes, artifactBytes) {
		t.Errorf("artifact file bytes mismatch: got %q, want %q", capturedBytes, artifactBytes)
	}
}

// ---------------------------------------------------------------------------
// Test: SHA mismatch → handler NOT called, failed status POSTed, temp removed.
// ---------------------------------------------------------------------------

func TestRunClaimLoop_SHAMismatch_HandlerNotCalled_FailedStatusPosted(t *testing.T) {
	const jobID = "job-sha-mismatch"

	var statusBody []byte
	var statusCalled atomic.Int32
	handlerCalled := false

	mux := buildClaimMux(
		func(w http.ResponseWriter, r *http.Request) {
			if statusCalled.Load() > 0 {
				// Already handled — serve no-job.
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(noJobClaimResponse())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(jobClaimResponse(jobID))
		},
		func(w http.ResponseWriter, r *http.Request) {
			// Serve bytes that DON'T match the declared SHA-256.
			corrupt := []byte("corrupted data, not matching sha256")
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-Artifact-SHA256", artifactSHA256) // header says correct SHA
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(corrupt)
		},
		func(w http.ResponseWriter, r *http.Request) {
			statusCalled.Add(1)
			var buf bytes.Buffer
			_, _ = io.Copy(&buf, r.Body)
			statusBody = buf.Bytes()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(okStatusResponse())
		},
	)

	_, client := newTestServer(t, mux)

	handle := JobHandler(func(_ context.Context, _ *central.ClaimBundle, _ string) error {
		handlerCalled = true
		return nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	_ = runClaim(ctx, client, 5*time.Millisecond, t.TempDir(), handle, discardLogger())

	if handlerCalled {
		t.Error("handler must NOT be called on SHA mismatch")
	}

	if statusCalled.Load() == 0 {
		t.Fatal("expected a failed status to be POSTed to /api/v1/dispatch/status")
	}

	// Assert the request body contains the expected fields.
	var got map[string]any
	if err := json.Unmarshal(statusBody, &got); err != nil {
		t.Fatalf("status body is not valid JSON: %v — body: %s", err, statusBody)
	}
	assertField(t, got, "phase", "failed")
	assertField(t, got, "job_id", jobID)
	assertField(t, got, "reason", "rejected")
	assertField(t, got, "details", "artifact-sha-mismatch")
}

// ---------------------------------------------------------------------------
// Test: handler returns error → logged, loop continues (next poll succeeds).
// ---------------------------------------------------------------------------

func TestRunClaimLoop_HandlerError_LoopContinues(t *testing.T) {
	const jobID = "job-handler-err"

	var claimCount atomic.Int32
	var handlerCallCount atomic.Int32

	mux := buildClaimMux(
		func(w http.ResponseWriter, r *http.Request) {
			n := claimCount.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			// First two polls: return a job (handler will fail on both; the loop
			// should continue re-polling and eventually hit the timeout).
			if n <= 2 {
				_, _ = w.Write(jobClaimResponse(jobID))
			} else {
				_, _ = w.Write(noJobClaimResponse())
			}
		},
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-Artifact-SHA256", artifactSHA256)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(artifactBytes)
		},
		nil,
	)

	_, client := newTestServer(t, mux)

	handle := JobHandler(func(_ context.Context, _ *central.ClaimBundle, _ string) error {
		handlerCallCount.Add(1)
		return fmt.Errorf("simulated handler failure")
	})

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	err := runClaim(ctx, client, 5*time.Millisecond, t.TempDir(), handle, discardLogger())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded (loop kept running), got %v", err)
	}

	// Handler should have been called at least once; loop should have continued.
	if handlerCallCount.Load() < 1 {
		t.Errorf("expected handler to be called at least once, got %d", handlerCallCount.Load())
	}
	// Claim count should be > handler call count (loop continued past handler errors).
	if claimCount.Load() <= handlerCallCount.Load() {
		t.Errorf("expected more claim polls (%d) than handler calls (%d) — loop should continue",
			claimCount.Load(), handlerCallCount.Load())
	}
}

// ---------------------------------------------------------------------------
// Test: transient Claim error → backoff + continue.
// ---------------------------------------------------------------------------

func TestRunClaimLoop_TransientClaimError_BackoffAndContinue(t *testing.T) {
	var claimCount atomic.Int32
	handlerCalled := false

	mux := buildClaimMux(
		func(w http.ResponseWriter, r *http.Request) {
			n := claimCount.Add(1)
			if n <= 2 {
				// First two calls: transient 500.
				http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
				return
			}
			// Third+: no job.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(noJobClaimResponse())
		},
		nil, nil,
	)

	_, client := newTestServer(t, mux)

	handle := JobHandler(func(_ context.Context, _ *central.ClaimBundle, _ string) error {
		handlerCalled = true
		return nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	err := runClaim(ctx, client, 5*time.Millisecond, t.TempDir(), handle, discardLogger())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded (loop kept running), got %v", err)
	}

	if handlerCalled {
		t.Error("handler must not be called when no job was available")
	}
	// Should have polled at least 3 times (2 errors + recovery).
	if claimCount.Load() < 3 {
		t.Errorf("expected at least 3 claim attempts after transient errors, got %d", claimCount.Load())
	}
}

// ---------------------------------------------------------------------------
// Test: context cancel during sleep exits cleanly.
// ---------------------------------------------------------------------------

func TestRunClaimLoop_ExitsOnContextCancel(t *testing.T) {
	mux := buildClaimMux(
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(noJobClaimResponse())
		},
		nil, nil,
	)

	_, client := newTestServer(t, mux)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()

	err := runClaim(ctx, client, 5*time.Millisecond, t.TempDir(), nil, discardLogger())
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Test: intervalSeconds <= 0 defaults via RunClaimLoop exported wrapper.
// ---------------------------------------------------------------------------

func TestRunClaimLoop_DefaultIntervalOnZeroOrNegative(t *testing.T) {
	var claimCount atomic.Int32

	mux := buildClaimMux(
		func(w http.ResponseWriter, r *http.Request) {
			claimCount.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(noJobClaimResponse())
		},
		nil, nil,
	)

	_, client := newTestServer(t, mux)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	// intervalSeconds=0 should default to 5; the first poll fires immediately
	// before any timer, so we'll see ≥1 call.
	err := RunClaimLoop(ctx, client, 0, t.TempDir(), nil, discardLogger())
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got %v", err)
	}
	if claimCount.Load() < 1 {
		t.Error("expected at least 1 claim poll even with default interval")
	}
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

// assertField checks that got[key] == wantStr (JSON values are decoded as
// string for assertion convenience).
func assertField(t *testing.T, got map[string]any, key, wantStr string) {
	t.Helper()
	v, ok := got[key]
	if !ok {
		t.Errorf("status body missing field %q; body keys: %v", key, keys(got))
		return
	}
	if fmt.Sprintf("%v", v) != wantStr {
		t.Errorf("status body field %q: want %q, got %q", key, wantStr, fmt.Sprintf("%v", v))
	}
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
