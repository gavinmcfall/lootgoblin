// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package agent

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// ---------------------------------------------------------------------------
// helpers shared across orchestrator tests
// ---------------------------------------------------------------------------

// moonrakerConnectionConfigJSON builds a minimal valid Moonraker
// connection_config JSON pointing to host:port.
func moonrakerConnectionConfigJSON(host string, port int) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"host":         host,
		"port":         port,
		"scheme":       "http",
		"startPrint":   false,
		"requiresAuth": false,
	})
	return b
}

// badConnectionConfigJSON is JSON that will fail ParseConnectionConfig
// (missing host).
var badConnectionConfigJSON = json.RawMessage(`{"port":7125}`)

// buildBundle creates a ClaimBundle with the given printer kind and
// connection_config.  credential is included when credPayload is non-nil.
func buildBundle(kind string, connConfig json.RawMessage, credPayload json.RawMessage) *central.ClaimBundle {
	b := &central.ClaimBundle{
		Job: central.ClaimJob{
			ID:         "test-job-001",
			TargetKind: "printer",
			TargetID:   "printer-001",
		},
		Printer: &central.ClaimPrinter{
			ID:               "printer-001",
			Kind:             kind,
			ConnectionConfig: connConfig,
		},
	}
	if credPayload != nil {
		b.Credential = &central.ClaimCredential{
			Kind:    "moonraker",
			Payload: credPayload,
		}
	}
	return b
}

// tempArtifact creates a small temp file containing data and returns its path.
// The file is automatically removed when the test ends.
func tempArtifact(t *testing.T, data []byte) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "artifact-*.gcode")
	if err != nil {
		t.Fatalf("create temp artifact: %v", err)
	}
	if _, err := f.Write(data); err != nil {
		t.Fatalf("write temp artifact: %v", err)
	}
	f.Close()
	return f.Name()
}

// statusCapture records each POST body sent to /api/v1/dispatch/status.
type statusCapture struct {
	reports []central.StatusReport
}

func (sc *statusCapture) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/dispatch/status" {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var rep central.StatusReport
		_ = json.Unmarshal(body, &rep)
		sc.reports = append(sc.reports, rep)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}
}

// newStatusServer creates an httptest.Server that answers /api/v1/dispatch/status
// and an additional handler fn for other paths (e.g. a fake Moonraker upload
// endpoint).  Returns the server URL and a *statusCapture.
func newStatusServer(t *testing.T, extra http.Handler) (*httptest.Server, *statusCapture) {
	t.Helper()
	sc := &statusCapture{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/dispatch/status", sc.handler())
	if extra != nil {
		mux.Handle("/", extra)
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, sc
}

// ---------------------------------------------------------------------------
// Test: unsupported printer kind → failed{unsupported-protocol}, no upload.
// ---------------------------------------------------------------------------

func TestMakeJobHandler_UnsupportedKind(t *testing.T) {
	srv, sc := newStatusServer(t, nil)
	client := central.New(srv.URL, "test-key", "2.0.0", nil)

	handler := MakeJobHandler(client, 1.24, 1.75, discardLogger())

	bundle := buildBundle("bambu_lan", badConnectionConfigJSON, nil)
	artifact := tempArtifact(t, []byte("G28\n"))

	err := handler(context.Background(), bundle, artifact)
	if err != nil {
		t.Fatalf("expected nil error from handler, got %v", err)
	}

	if len(sc.reports) != 1 {
		t.Fatalf("expected 1 status report, got %d", len(sc.reports))
	}
	rep := sc.reports[0]
	if rep.Phase != "failed" {
		t.Errorf("expected phase=failed, got %q", rep.Phase)
	}
	if rep.Reason != "unsupported-protocol" {
		t.Errorf("expected reason=unsupported-protocol, got %q", rep.Reason)
	}
}

// ---------------------------------------------------------------------------
// Test: connection_config parse error → failed posted, no upload.
// ---------------------------------------------------------------------------

func TestMakeJobHandler_ParseConfigError(t *testing.T) {
	srv, sc := newStatusServer(t, nil)
	client := central.New(srv.URL, "test-key", "2.0.0", nil)

	handler := MakeJobHandler(client, 1.24, 1.75, discardLogger())

	// badConnectionConfigJSON is missing host → ParseConnectionConfig error.
	bundle := buildBundle(moonrakerKind, badConnectionConfigJSON, nil)
	artifact := tempArtifact(t, []byte("G28\n"))

	err := handler(context.Background(), bundle, artifact)
	if err != nil {
		t.Fatalf("expected nil error from handler, got %v", err)
	}

	if len(sc.reports) != 1 {
		t.Fatalf("expected 1 status report, got %d", len(sc.reports))
	}
	rep := sc.reports[0]
	if rep.Phase != "failed" {
		t.Errorf("expected phase=failed, got %q", rep.Phase)
	}
	if rep.JobID != "test-job-001" {
		t.Errorf("expected job_id=test-job-001, got %q", rep.JobID)
	}
}

// ---------------------------------------------------------------------------
// Test: Moonraker upload fails (fake returns 500) → failed{unknown} posted.
// ---------------------------------------------------------------------------

func TestMakeJobHandler_UploadFailure(t *testing.T) {
	// Fake Moonraker: always returns 500 on the upload endpoint.
	var uploadHits atomic.Int32
	fakeMoonraker := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/server/files/upload" {
			uploadHits.Add(1)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		http.NotFound(w, r)
	})

	srv, sc := newStatusServer(t, fakeMoonraker)
	client := central.New(srv.URL, "test-key", "2.0.0", nil)
	handler := MakeJobHandler(client, 1.24, 1.75, discardLogger())

	// Moonraker connection points at the test server.
	host := "127.0.0.1"
	port := srv.Listener.Addr().(*netTCPAddr).Port

	bundle := buildBundle(moonrakerKind, moonrakerConnectionConfigJSON(host, port), nil)
	artifact := tempArtifact(t, []byte("G28\n"))

	err := handler(context.Background(), bundle, artifact)
	if err != nil {
		t.Fatalf("expected nil error from handler (dispatch failure is reported, not returned), got %v", err)
	}

	if uploadHits.Load() == 0 {
		t.Error("expected at least one upload attempt to fake Moonraker")
	}

	// Find the failed report.
	var failedReports []central.StatusReport
	for _, r := range sc.reports {
		if r.Phase == "failed" {
			failedReports = append(failedReports, r)
		}
	}
	if len(failedReports) == 0 {
		t.Fatalf("expected a failed status report, got reports: %+v", sc.reports)
	}
	rep := failedReports[0]
	if rep.Reason != "unknown" {
		t.Errorf("expected reason=unknown (5xx), got %q", rep.Reason)
	}
}

// ---------------------------------------------------------------------------
// Test: Moonraker upload succeeds → dispatched report posted with
// remote_filename; Subscribe tries to connect, fails fast, and does NOT
// cause a failed report (the handler returns the Subscribe error).
// ---------------------------------------------------------------------------

func TestMakeJobHandler_DispatchSuccessSubscribeDrop(t *testing.T) {
	var uploadHits atomic.Int32

	// Fake Moonraker: upload succeeds; no WebSocket endpoint (Subscribe fails fast).
	fakeMoonraker := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/server/files/upload" {
			uploadHits.Add(1)
			resp := map[string]any{
				"result": map[string]any{
					"item": map[string]any{
						"path": "test-file.gcode",
					},
				},
			}
			b, _ := json.Marshal(resp)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(b)
			return
		}
		// Any other path (including /websocket) → 404 → Subscribe fails fast.
		http.NotFound(w, r)
	})

	srv, sc := newStatusServer(t, fakeMoonraker)
	client := central.New(srv.URL, "test-key", "2.0.0", nil)
	handler := MakeJobHandler(client, 1.24, 1.75, discardLogger())

	host := "127.0.0.1"
	port := srv.Listener.Addr().(*netTCPAddr).Port

	bundle := buildBundle(moonrakerKind, moonrakerConnectionConfigJSON(host, port), nil)
	artifact := tempArtifact(t, []byte("G28\n"))

	err := handler(context.Background(), bundle, artifact)
	// Subscribe will fail (no WS endpoint) — gorilla returns an error on a
	// non-101 upgrade.  The handler must return that error AND must NOT post
	// a failed report.
	if err == nil {
		t.Error("expected non-nil error from handler when Subscribe fails on non-101 upgrade")
	}

	// Upload must have been called.
	if uploadHits.Load() == 0 {
		t.Error("expected upload to reach fake Moonraker")
	}

	// There must be a dispatched report.
	var dispatchedReports []central.StatusReport
	var failedReports []central.StatusReport
	for _, r := range sc.reports {
		switch r.Phase {
		case "dispatched":
			dispatchedReports = append(dispatchedReports, r)
		case "failed":
			failedReports = append(failedReports, r)
		}
	}

	if len(dispatchedReports) == 0 {
		t.Fatalf("expected a dispatched report; all reports: %+v", sc.reports)
	}
	if dispatchedReports[0].RemoteFilename != "test-file.gcode" {
		t.Errorf("expected remote_filename=test-file.gcode, got %q", dispatchedReports[0].RemoteFilename)
	}

	// "we sent the file ≠ the print failed" — no failed report must appear.
	if len(failedReports) > 0 {
		t.Errorf("expected no failed reports after Subscribe drop, got: %+v", failedReports)
	}
}

// ---------------------------------------------------------------------------
// Test: nil Printer in bundle → failed{unsupported-protocol} posted AND handler
// returns a non-nil error.  This is the ONLY path that both reports failed and
// returns an error (unsupported-kind reports failed but returns nil; dispatch
// failure reports failed but returns nil; Subscribe failure returns an error
// but does NOT report failed).
// ---------------------------------------------------------------------------

func TestMakeJobHandler_NilPrinter(t *testing.T) {
	srv, sc := newStatusServer(t, nil)
	client := central.New(srv.URL, "test-key", "2.0.0", nil)

	handler := MakeJobHandler(client, 1.24, 1.75, discardLogger())

	// Build a bundle with Printer == nil.
	bundle := &central.ClaimBundle{
		Job: central.ClaimJob{
			ID:         "nil-printer-job",
			TargetKind: "printer",
			TargetID:   "printer-001",
		},
		Printer: nil,
	}
	artifact := tempArtifact(t, []byte("G28\n"))

	err := handler(context.Background(), bundle, artifact)
	if err == nil {
		t.Fatal("expected non-nil error from handler when Printer == nil")
	}

	// Must also have posted a failed{unsupported-protocol} report.
	if len(sc.reports) != 1 {
		t.Fatalf("expected 1 status report, got %d", len(sc.reports))
	}
	rep := sc.reports[0]
	if rep.Phase != "failed" {
		t.Errorf("expected phase=failed, got %q", rep.Phase)
	}
	if rep.Reason != "unsupported-protocol" {
		t.Errorf("expected reason=unsupported-protocol, got %q", rep.Reason)
	}
	if rep.JobID != "nil-printer-job" {
		t.Errorf("expected job_id=nil-printer-job, got %q", rep.JobID)
	}
}

// netTCPAddr is an alias for net.TCPAddr used in port-extraction helpers.
type netTCPAddr = net.TCPAddr
