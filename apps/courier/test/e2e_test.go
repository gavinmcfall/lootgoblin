// Package e2e contains cross-cutting end-to-end tests for the courier.
//
// B-1 (always runs): in-process wiring e2e using httptest stubs — no real
// network dependencies.  Two httptest.Servers are spun up: one emulates the
// central instance (claim / artifact / status / heartbeat), the other emulates
// a Moonraker printer (file upload).  The real central.Client + agent.MakeJobHandler
// + agent.RunClaimLoop are driven end-to-end.
//
// B-2 (skip unless COURIER_E2E=1): documented stub for a full-stack run against
// a real central instance and real/fake Moonraker, including WebSocket status feed.
//
// NOTE: Moonraker protocol fixtures (WebSocket frame sequences) are kept inline
// here rather than in tests/printer-protocols/fixtures/ — that fixture directory
// is deferred to V2-006c.  Revisit once V2-006c lands.
package e2e

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/agent"
	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// ---------------------------------------------------------------------------
// B-1: in-process wiring e2e (always runs)
// ---------------------------------------------------------------------------

// TestE2E_InProcess drives the full claim → download → dispatch → subscribe
// pipeline using only httptest stubs (no real network deps).
//
// Assertions:
//   - central stub received a "dispatched" status with the correct remote_filename
//   - central stub received NO "failed" status (Subscribe feed drop ≠ print failed)
//   - artifact bytes were correctly downloaded and SHA-verified by the claim loop
//     (the handler is only called when the SHA matches, so reaching the handler
//     is evidence of successful SHA verification)
func TestE2E_InProcess(t *testing.T) {
	const jobID = "e2e-job-001"

	// Deterministic artifact bytes + their SHA-256.
	artifactContent := []byte("G28\nG1 Z10\nG1 X50 Y50 F3000\n")
	h := sha256.Sum256(artifactContent)
	artifactSHA := hex.EncodeToString(h[:])

	// -----------------------------------------------------------------------
	// Fake Moonraker: serves the upload endpoint only.
	// Any other path (including /websocket) → 404 so Subscribe fails fast.
	// This is intentional: a 404 on /websocket means gorilla returns a non-nil
	// error → the handler returns it → but NO failed report is posted
	// ("sent ≠ failed" contract).
	// -----------------------------------------------------------------------
	var moonrakerUploadHits atomic.Int32
	moonrakerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/server/files/upload" {
			moonrakerUploadHits.Add(1)
			// Drain the body so the connection stays clean.
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, `{"result":{"item":{"path":"gcodes/e2e-job.gcode"}}}`)
			return
		}
		// /websocket and everything else → 404 (Subscribe fails fast, not a failure).
		http.NotFound(w, r)
	}))
	defer moonrakerSrv.Close()

	// Extract Moonraker host+port so we can inject them into the claim response.
	moonrakerAddr := moonrakerSrv.Listener.Addr().String()
	moonrakerHost, moonrakerPortStr, err := splitHostPort(moonrakerAddr)
	if err != nil {
		t.Fatalf("parse moonraker addr %q: %v", moonrakerAddr, err)
	}
	var moonrakerPort int
	if _, err := fmt.Sscanf(moonrakerPortStr, "%d", &moonrakerPort); err != nil {
		t.Fatalf("parse moonraker port %q: %v", moonrakerPortStr, err)
	}

	// Moonraker connection_config JSON pointing at the fake Moonraker.
	connCfgBytes, err := json.Marshal(map[string]any{
		"host":         moonrakerHost,
		"port":         moonrakerPort,
		"scheme":       "http",
		"startPrint":   false,
		"requiresAuth": false,
	})
	if err != nil {
		t.Fatalf("marshal connection_config: %v", err)
	}

	// -----------------------------------------------------------------------
	// Central stub: claim / artifact download / status reporting / heartbeat.
	// -----------------------------------------------------------------------
	var (
		claimCallCount atomic.Int32
		statusMu       sync.Mutex
		statusReports  []central.StatusReport
	)

	centralMux := http.NewServeMux()

	// POST /api/v1/dispatch/claim — return ONE job on the first call, then no-job.
	centralMux.HandleFunc("/api/v1/dispatch/claim", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		n := claimCallCount.Add(1)
		if n == 1 {
			// First claim: return a job.  Connection_config points at fake Moonraker.
			resp := map[string]any{
				"job": map[string]any{
					"id":          jobID,
					"target_kind": "printer",
					"target_id":   "printer-001",
					"loot_id":     "loot-001",
					"owner_id":    "owner-001",
				},
				"printer": map[string]any{
					"id":                "printer-001",
					"kind":              "fdm_klipper",
					"connection_config": json.RawMessage(connCfgBytes),
				},
				"artifact": map[string]any{
					"job_id":     jobID,
					"size_bytes": len(artifactContent),
					"sha256":     artifactSHA,
					"mime_type":  "text/x-gcode",
				},
			}
			b, _ := json.Marshal(resp)
			_, _ = w.Write(b)
			return
		}
		// Subsequent calls: no job available.
		noJob := map[string]any{"job": nil}
		b, _ := json.Marshal(noJob)
		_, _ = w.Write(b)
	})

	// GET /api/v1/dispatch/artifact/<id> — serve the artifact bytes + SHA header.
	centralMux.HandleFunc("/api/v1/dispatch/artifact/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Artifact-SHA256", artifactSHA)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(artifactContent)
	})

	// POST /api/v1/dispatch/status — record all reports.
	centralMux.HandleFunc("/api/v1/dispatch/status", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var rep central.StatusReport
		_ = json.Unmarshal(body, &rep)
		statusMu.Lock()
		statusReports = append(statusReports, rep)
		statusMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	// POST /api/v1/couriers/heartbeat — simple 200 OK.
	centralMux.HandleFunc("/api/v1/couriers/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		b, _ := json.Marshal(map[string]any{
			"ok":                         true,
			"server_version":             "2.0.0",
			"heartbeat_interval_seconds": 60,
		})
		_, _ = w.Write(b)
	})

	centralSrv := httptest.NewServer(centralMux)
	defer centralSrv.Close()

	// -----------------------------------------------------------------------
	// Wire up the real components.
	// -----------------------------------------------------------------------
	client := central.New(centralSrv.URL, "e2e-api-key", "2.0.0", nil)

	discardLog := discardLogger()
	handler := agent.MakeJobHandler(client, 1.24, 1.75, discardLog)

	// -----------------------------------------------------------------------
	// Drive RunClaimLoop — cancel the context shortly after the first job is
	// handled (give it enough time to pick up the job + subscribe-fail + poll
	// once more, but not so long that the test is slow).
	// -----------------------------------------------------------------------
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Run the claim loop in a goroutine so we can cancel it deterministically.
	loopDone := make(chan error, 1)
	go func() {
		loopDone <- agent.RunClaimLoop(ctx, client, 1 /*interval=1s*/, t.TempDir(), handler, discardLog)
	}()

	// Wait until we have seen at least one status report OR the context expires.
	deadline := time.After(1500 * time.Millisecond)
	for {
		statusMu.Lock()
		n := len(statusReports)
		statusMu.Unlock()
		if n > 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("timed out waiting for first status report from central stub")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}

	// Cancel the loop — we have the data we need.
	cancel()
	<-loopDone

	// -----------------------------------------------------------------------
	// Assertions.
	// -----------------------------------------------------------------------

	// 1. Moonraker upload was reached.
	if moonrakerUploadHits.Load() == 0 {
		t.Error("expected fake Moonraker to receive at least one upload request")
	}

	// 2. Central stub received a "dispatched" report with the correct remote_filename.
	statusMu.Lock()
	reports := make([]central.StatusReport, len(statusReports))
	copy(reports, statusReports)
	statusMu.Unlock()

	var dispatched []central.StatusReport
	var failed []central.StatusReport
	for _, r := range reports {
		switch r.Phase {
		case "dispatched":
			dispatched = append(dispatched, r)
		case "failed":
			failed = append(failed, r)
		}
	}

	if len(dispatched) == 0 {
		t.Fatalf("expected at least one dispatched status report; all reports: %+v", reports)
	}
	if dispatched[0].RemoteFilename != "gcodes/e2e-job.gcode" {
		t.Errorf("dispatched remote_filename: want %q, got %q",
			"gcodes/e2e-job.gcode", dispatched[0].RemoteFilename)
	}
	if dispatched[0].JobID != jobID {
		t.Errorf("dispatched job_id: want %q, got %q", jobID, dispatched[0].JobID)
	}

	// 3. NO "failed" report — Subscribe feed drop must NOT fail the job.
	if len(failed) > 0 {
		t.Errorf("expected no failed reports (Subscribe feed drop ≠ print failed); got: %+v", failed)
	}
}

// ---------------------------------------------------------------------------
// B-2: full-stack test stub (requires COURIER_E2E=1)
// ---------------------------------------------------------------------------

// TestE2E_FullStack tests the courier against a real central instance and a
// real or fake Moonraker printer, including the WebSocket status feed, asserting
// a final "completed" report with measured grams.
//
// This test is deliberately skipped in CI and the default test run.  To run it:
//
//	export COURIER_E2E=1
//	export COURIER_E2E_CENTRAL_URL=http://localhost:7393
//	export COURIER_E2E_CENTRAL_API_KEY=<api-key>
//	export COURIER_E2E_MOONRAKER_HOST=klipper.local  # or a fake Moonraker
//	go test ./test/... -run TestE2E_FullStack -v
//
// The test requires:
//   - A running central instance at COURIER_E2E_CENTRAL_URL with a courier
//     already paired (API key in COURIER_E2E_CENTRAL_API_KEY).
//   - A Moonraker/Klipper printer reachable at COURIER_E2E_MOONRAKER_HOST:7125,
//     or a fake Moonraker with a proper WebSocket endpoint that sends
//     notify_history_changed{action:"finished", job:{status:"completed"}} with
//     a non-zero filament_used value.
//
// The test asserts:
//   - The claim loop picks up a job from the central instance.
//   - The artifact is uploaded to Moonraker.
//   - The WebSocket status feed delivers a "completed" report.
//   - The central instance received a "completed" phase report with
//     materials_used[0].measured_grams > 0.
func TestE2E_FullStack(t *testing.T) {
	if os.Getenv("COURIER_E2E") != "1" {
		t.Skip("skipping full-stack e2e test; set COURIER_E2E=1 to enable. " +
			"Requires COURIER_E2E_CENTRAL_URL, COURIER_E2E_CENTRAL_API_KEY, " +
			"and a Moonraker instance at COURIER_E2E_MOONRAKER_HOST:7125 " +
			"with a real or fake WebSocket status feed.")
	}

	// When COURIER_E2E=1 this stub will be replaced with a real implementation
	// in a future session (V2-006c or a dedicated e2e task).  For now it fails
	// loudly to remind the implementer to wire it up.
	t.Fatal("TestE2E_FullStack is not yet implemented — wire it up before enabling COURIER_E2E=1")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// discardLogger returns a no-op slog.Logger for tests.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// splitHostPort splits an "host:port" string into its components.
// Unlike net.SplitHostPort, this helper tolerates IPv4 addresses only
// (sufficient for httptest.Server addresses) and does not import net.
func splitHostPort(hostport string) (host, port string, err error) {
	for i := len(hostport) - 1; i >= 0; i-- {
		if hostport[i] == ':' {
			return hostport[:i], hostport[i+1:], nil
		}
	}
	return "", "", fmt.Errorf("splitHostPort: missing port in %q", hostport)
}
