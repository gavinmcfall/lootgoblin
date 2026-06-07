package central_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const testAPIKey = "test-api-key-abc"
const testVersion = "2.0.0"

// newClient creates a Client pointed at srv with a fresh http.Client that has
// no timeout (test server responds immediately).
func newClient(t *testing.T, baseURL string) *central.Client {
	t.Helper()
	hc := &http.Client{}
	return central.New(baseURL, testAPIKey, testVersion, hc)
}

// serveJSON registers a fixed JSON handler on the mux at path and records the
// last request for assertion.
func serveOnce(t *testing.T, mux *http.ServeMux, method, path string, status int, body interface{}, verifyFn func(*http.Request)) {
	t.Helper()
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			t.Errorf("expected method %s, got %s for %s", method, r.Method, path)
		}
		if verifyFn != nil {
			verifyFn(r)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if body != nil {
			if err := json.NewEncoder(w).Encode(body); err != nil {
				t.Errorf("encode response: %v", err)
			}
		}
	})
}

// mustDecodeBody unmarshals the request body into dst.
func mustDecodeBody(t *testing.T, r *http.Request, dst interface{}) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		t.Fatalf("decode request body: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Base-URL normalization
// ---------------------------------------------------------------------------

func TestBaseURLNormalization(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/instance", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id":         "inst-1",
			"public_key": "pk",
			"name":       "test",
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// With trailing slash
	c := central.New(srv.URL+"/", testAPIKey, testVersion, &http.Client{})
	inst, err := c.GetInstance(context.Background())
	if err != nil {
		t.Fatalf("trailing slash: %v", err)
	}
	if inst.ID != "inst-1" {
		t.Errorf("trailing slash: id = %q, want inst-1", inst.ID)
	}

	// Without trailing slash
	c2 := central.New(srv.URL, testAPIKey, testVersion, &http.Client{})
	inst2, err := c2.GetInstance(context.Background())
	if err != nil {
		t.Fatalf("no trailing slash: %v", err)
	}
	if inst2.ID != "inst-1" {
		t.Errorf("no trailing slash: id = %q, want inst-1", inst2.ID)
	}
}

// ---------------------------------------------------------------------------
// GetInstance
// ---------------------------------------------------------------------------

func TestGetInstance(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodGet, "/api/v1/instance", http.StatusOK,
		map[string]string{"id": "inst-abc", "public_key": "AAAApk", "name": "Home Lab"},
		func(r *http.Request) {
			// Must NOT have x-api-key.
			if r.Header.Get("x-api-key") != "" {
				t.Error("GetInstance must not send x-api-key")
			}
		},
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	inst, err := c.GetInstance(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if inst.ID != "inst-abc" {
		t.Errorf("ID = %q, want inst-abc", inst.ID)
	}
	if inst.PublicKey != "AAAApk" {
		t.Errorf("PublicKey = %q, want AAAApk", inst.PublicKey)
	}
	if inst.Name != "Home Lab" {
		t.Errorf("Name = %q, want Home Lab", inst.Name)
	}
}

// ---------------------------------------------------------------------------
// Pair
// ---------------------------------------------------------------------------

func TestPair_Success(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/couriers/pair", http.StatusOK,
		map[string]string{
			"api_key":        "key-xyz",
			"agent_id":       "agent-1",
			"instance_id":    "inst-1",
			"server_version": "2.0.0",
		},
		func(r *http.Request) {
			// Must NOT have x-api-key header.
			if r.Header.Get("x-api-key") != "" {
				t.Error("Pair must not send x-api-key")
			}
			var body map[string]interface{}
			mustDecodeBody(t, r, &body)
			if body["token"] != "tok123" {
				t.Errorf("token = %v, want tok123", body["token"])
			}
			if body["name"] != "my-courier" {
				t.Errorf("name = %v, want my-courier", body["name"])
			}
			if body["reachable_lan_hint"] != "192.168.1.50" {
				t.Errorf("reachable_lan_hint = %v, want 192.168.1.50", body["reachable_lan_hint"])
			}
		},
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	result, err := c.Pair(context.Background(), "tok123", "my-courier", "192.168.1.50")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.APIKey != "key-xyz" {
		t.Errorf("APIKey = %q, want key-xyz", result.APIKey)
	}
	if result.AgentID != "agent-1" {
		t.Errorf("AgentID = %q, want agent-1", result.AgentID)
	}
	if result.InstanceID != "inst-1" {
		t.Errorf("InstanceID = %q, want inst-1", result.InstanceID)
	}
	if result.ServerVersion != "2.0.0" {
		t.Errorf("ServerVersion = %q, want 2.0.0", result.ServerVersion)
	}
}

func TestPair_InvalidToken_WrongKind(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/couriers/pair", http.StatusBadRequest,
		map[string]string{"error": "invalid-pair-token", "reason": "wrong-kind"},
		nil,
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	_, err := c.Pair(context.Background(), "bad-tok", "", "")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, central.ErrInvalidPairToken) {
		t.Errorf("errors.Is(err, ErrInvalidPairToken) = false; err = %v", err)
	}
	var pte *central.PairTokenError
	if !errors.As(err, &pte) {
		t.Fatalf("expected *PairTokenError, got %T", err)
	}
	if pte.Reason != "wrong-kind" {
		t.Errorf("Reason = %q, want wrong-kind", pte.Reason)
	}
}

func TestPair_InvalidToken_InvalidOrExpired(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/couriers/pair", http.StatusBadRequest,
		map[string]string{"error": "invalid-pair-token", "reason": "invalid-or-expired"},
		nil,
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	_, err := c.Pair(context.Background(), "expired-tok", "", "")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, central.ErrInvalidPairToken) {
		t.Errorf("errors.Is(err, ErrInvalidPairToken) = false")
	}
	var pte *central.PairTokenError
	if errors.As(err, &pte) && pte.Reason != "invalid-or-expired" {
		t.Errorf("Reason = %q, want invalid-or-expired", pte.Reason)
	}
}

func TestPair_AlreadyUsed(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/couriers/pair", http.StatusConflict,
		map[string]string{"error": "pair-token-already-used"},
		nil,
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	_, err := c.Pair(context.Background(), "used-tok", "", "")
	if !errors.Is(err, central.ErrPairTokenUsed) {
		t.Errorf("errors.Is(err, ErrPairTokenUsed) = false; err = %v", err)
	}
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

func TestHeartbeat_Success(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/couriers/heartbeat", http.StatusOK,
		map[string]interface{}{
			"ok":                         true,
			"server_version":             "2.0.0",
			"heartbeat_interval_seconds": 30,
		},
		func(r *http.Request) {
			if r.Header.Get("x-api-key") != testAPIKey {
				t.Errorf("x-api-key = %q, want %q", r.Header.Get("x-api-key"), testAPIKey)
			}
			var body map[string]interface{}
			mustDecodeBody(t, r, &body)
			if body["courier_version"] != testVersion {
				t.Errorf("courier_version = %v, want %s", body["courier_version"], testVersion)
			}
		},
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	req := central.HeartbeatRequest{
		CourierVersion: testVersion,
		Printers: []central.PrinterEntry{
			{PrinterID: "p1", ReachableStatus: "reachable"},
		},
	}
	result, err := c.Heartbeat(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.OK {
		t.Error("OK = false, want true")
	}
	if result.ServerVersion != "2.0.0" {
		t.Errorf("ServerVersion = %q, want 2.0.0", result.ServerVersion)
	}
	if result.HeartbeatIntervalSeconds != 30 {
		t.Errorf("HeartbeatIntervalSeconds = %d, want 30", result.HeartbeatIntervalSeconds)
	}
}

func TestHeartbeat_VersionIncompatible(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/couriers/heartbeat", http.StatusConflict,
		map[string]interface{}{
			"error":          "version-incompatible",
			"server_version": "3.0.0",
			"action":         "upgrade",
		},
		nil,
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	_, err := c.Heartbeat(context.Background(), central.HeartbeatRequest{CourierVersion: "2.0.0"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, central.ErrVersionIncompatible) {
		t.Errorf("errors.Is(err, ErrVersionIncompatible) = false; err = %v", err)
	}
	var vie *central.VersionIncompatibleError
	if !errors.As(err, &vie) {
		t.Fatalf("expected *VersionIncompatibleError, got %T", err)
	}
	if vie.ServerVersion != "3.0.0" {
		t.Errorf("ServerVersion = %q, want 3.0.0", vie.ServerVersion)
	}
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

func TestClaim_NullJob(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/dispatch/claim", http.StatusOK,
		map[string]interface{}{"job": nil},
		func(r *http.Request) {
			if r.Header.Get("x-api-key") != testAPIKey {
				t.Errorf("x-api-key missing or wrong")
			}
		},
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	bundle, err := c.Claim(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if bundle != nil {
		t.Errorf("expected nil bundle for job:null, got %+v", bundle)
	}
}

func TestClaim_FullBundle(t *testing.T) {
	connCfg := json.RawMessage(`{"host":"printer.local","port":7125}`)
	credPayload := json.RawMessage(`{"username":"admin","password":"secret"}`)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/dispatch/claim", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		resp := map[string]interface{}{
			"job": map[string]string{
				"id":          "job-1",
				"target_kind": "printer",
				"target_id":   "prt-1",
				"loot_id":     "loot-1",
				"owner_id":    "user-1",
			},
			"printer": map[string]interface{}{
				"id":                "prt-1",
				"kind":              "moonraker",
				"connection_config": connCfg,
			},
			"credential": map[string]interface{}{
				"kind":    "moonraker-basic",
				"payload": credPayload,
			},
			"artifact": map[string]interface{}{
				"job_id":       "job-1",
				"size_bytes":   1234567,
				"sha256":       "abc123",
				"mime_type":    "model/gcode",
				"download_url": "/api/v1/dispatch/artifact/job-1",
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	bundle, err := c.Claim(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if bundle == nil {
		t.Fatal("expected bundle, got nil")
	}

	// Job
	if bundle.Job.ID != "job-1" {
		t.Errorf("Job.ID = %q, want job-1", bundle.Job.ID)
	}
	if bundle.Job.TargetKind != "printer" {
		t.Errorf("Job.TargetKind = %q, want printer", bundle.Job.TargetKind)
	}

	// Printer — ConnectionConfig must remain RawMessage
	if bundle.Printer == nil {
		t.Fatal("Printer is nil")
	}
	if bundle.Printer.Kind != "moonraker" {
		t.Errorf("Printer.Kind = %q, want moonraker", bundle.Printer.Kind)
	}
	if !json.Valid(bundle.Printer.ConnectionConfig) {
		t.Error("Printer.ConnectionConfig is not valid JSON")
	}
	// Verify it has not been further unmarshalled (still raw bytes).
	if !bytes.Contains(bundle.Printer.ConnectionConfig, []byte("printer.local")) {
		t.Errorf("ConnectionConfig does not contain expected string: %s", bundle.Printer.ConnectionConfig)
	}

	// Credential — Payload must remain RawMessage
	if bundle.Credential == nil {
		t.Fatal("Credential is nil")
	}
	if bundle.Credential.Kind != "moonraker-basic" {
		t.Errorf("Credential.Kind = %q, want moonraker-basic", bundle.Credential.Kind)
	}
	if !json.Valid(bundle.Credential.Payload) {
		t.Error("Credential.Payload is not valid JSON")
	}
	if !bytes.Contains(bundle.Credential.Payload, []byte("secret")) {
		t.Errorf("Credential.Payload does not contain expected string: %s", bundle.Credential.Payload)
	}

	// Artifact
	if bundle.Artifact == nil {
		t.Fatal("Artifact is nil")
	}
	if bundle.Artifact.SHA256 != "abc123" {
		t.Errorf("Artifact.SHA256 = %q, want abc123", bundle.Artifact.SHA256)
	}
	if bundle.Artifact.SizeBytes != 1234567 {
		t.Errorf("Artifact.SizeBytes = %d, want 1234567", bundle.Artifact.SizeBytes)
	}
}

func TestClaim_Unauthorized(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/dispatch/claim", http.StatusUnauthorized,
		map[string]string{"error": "unauthorized"},
		nil,
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	_, err := c.Claim(context.Background())
	if !errors.Is(err, central.ErrUnauthorized) {
		t.Errorf("errors.Is(err, ErrUnauthorized) = false; err = %v", err)
	}
}

// ---------------------------------------------------------------------------
// DownloadArtifact
// ---------------------------------------------------------------------------

func TestDownloadArtifact_Success(t *testing.T) {
	fileContent := []byte("G28\nG1 X100 Y100 Z10\nM104 S200\n")
	sha256Val := "deadbeefdeadbeef"

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/dispatch/artifact/job-99", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.Header.Get("x-api-key") != testAPIKey {
			t.Errorf("x-api-key missing")
		}
		w.Header().Set("X-Artifact-SHA256", sha256Val)
		w.Header().Set("Content-Type", "model/gcode")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(fileContent)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	var buf bytes.Buffer
	sha, err := c.DownloadArtifact(context.Background(), "job-99", &buf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sha != sha256Val {
		t.Errorf("sha256 header = %q, want %q", sha, sha256Val)
	}
	if !bytes.Equal(buf.Bytes(), fileContent) {
		t.Errorf("streamed bytes mismatch: got %q, want %q", buf.Bytes(), fileContent)
	}
}

func TestDownloadArtifact_Forbidden(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/dispatch/artifact/job-bad", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":"forbidden"}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	var buf bytes.Buffer
	_, err := c.DownloadArtifact(context.Background(), "job-bad", &buf)
	if !errors.Is(err, central.ErrForbidden) {
		t.Errorf("errors.Is(err, ErrForbidden) = false; err = %v", err)
	}
}

func TestDownloadArtifact_NotFound(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/dispatch/artifact/job-gone", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"not-found"}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	var buf bytes.Buffer
	_, err := c.DownloadArtifact(context.Background(), "job-gone", &buf)
	if !errors.Is(err, central.ErrArtifactNotFound) {
		t.Errorf("errors.Is(err, ErrArtifactNotFound) = false; err = %v", err)
	}
}

// ---------------------------------------------------------------------------
// ReportStatus — all four phases
// ---------------------------------------------------------------------------

func TestReportStatus_Dispatched(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/dispatch/status", http.StatusOK,
		map[string]interface{}{"ok": true},
		func(r *http.Request) {
			if r.Header.Get("x-api-key") != testAPIKey {
				t.Error("x-api-key missing")
			}
			var body map[string]interface{}
			mustDecodeBody(t, r, &body)
			if body["phase"] != "dispatched" {
				t.Errorf("phase = %v, want dispatched", body["phase"])
			}
			if body["job_id"] != "job-1" {
				t.Errorf("job_id = %v, want job-1", body["job_id"])
			}
			if body["remote_filename"] != "print_001.gcode" {
				t.Errorf("remote_filename = %v, want print_001.gcode", body["remote_filename"])
			}
		},
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	err := c.ReportStatus(context.Background(), central.DispatchedReport("job-1", "print_001.gcode"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReportStatus_Failed(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/dispatch/status", http.StatusOK,
		map[string]interface{}{"ok": true},
		func(r *http.Request) {
			var body map[string]interface{}
			mustDecodeBody(t, r, &body)
			if body["phase"] != "failed" {
				t.Errorf("phase = %v, want failed", body["phase"])
			}
			if body["reason"] != "unreachable" {
				t.Errorf("reason = %v, want unreachable", body["reason"])
			}
			if body["details"] != "connection refused" {
				t.Errorf("details = %v, want 'connection refused'", body["details"])
			}
		},
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	err := c.ReportStatus(context.Background(), central.FailedReport("job-1", "unreachable", "connection refused"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReportStatus_StatusEvent(t *testing.T) {
	pct := 42.5
	layer := 10
	total := 100

	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/dispatch/status", http.StatusOK,
		map[string]interface{}{"ok": true},
		func(r *http.Request) {
			var body map[string]interface{}
			mustDecodeBody(t, r, &body)
			if body["phase"] != "status-event" {
				t.Errorf("phase = %v, want status-event", body["phase"])
			}
			event, ok := body["event"].(map[string]interface{})
			if !ok {
				t.Fatalf("event is not an object: %T", body["event"])
			}
			if event["kind"] != "printing" {
				t.Errorf("event.kind = %v, want printing", event["kind"])
			}
			if event["progress_pct"] != 42.5 {
				t.Errorf("event.progress_pct = %v, want 42.5", event["progress_pct"])
			}
		},
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	event := central.StatusEventPayload{
		Kind:         "printing",
		RemoteJobRef: "remote-123",
		ProgressPct:  &pct,
		LayerNum:     &layer,
		TotalLayers:  &total,
	}
	err := c.ReportStatus(context.Background(), central.StatusEventReport("job-1", event))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReportStatus_Completed(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/dispatch/status", http.StatusOK,
		map[string]interface{}{"ok": true},
		func(r *http.Request) {
			var body map[string]interface{}
			mustDecodeBody(t, r, &body)
			if body["phase"] != "completed" {
				t.Errorf("phase = %v, want completed", body["phase"])
			}
			mats, ok := body["materials_used"].([]interface{})
			if !ok || len(mats) != 1 {
				t.Fatalf("materials_used: expected 1 entry, got %v", body["materials_used"])
			}
			m := mats[0].(map[string]interface{})
			if m["material_id"] != "mat-1" {
				t.Errorf("material_id = %v, want mat-1", m["material_id"])
			}
		},
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	mats := []central.MaterialsUsedSlot{
		{SlotIndex: 0, MaterialID: "mat-1", MeasuredGrams: 12.5},
	}
	err := c.ReportStatus(context.Background(), central.CompletedReport("job-1", mats))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReportStatus_NoopSuccess(t *testing.T) {
	mux := http.NewServeMux()
	serveOnce(t, mux, http.MethodPost, "/api/v1/dispatch/status", http.StatusOK,
		map[string]interface{}{"ok": true, "noop": true},
		nil,
	)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newClient(t, srv.URL)
	err := c.ReportStatus(context.Background(), central.DispatchedReport("job-1", ""))
	if err != nil {
		t.Fatalf("noop response should be success, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Nil http.Client defaults to 30s client
// ---------------------------------------------------------------------------

func TestNilHTTPClientDefaultsApplied(t *testing.T) {
	// Just verify New doesn't panic and returns a usable client.
	c := central.New("http://localhost:9999", "key", "2.0.0", nil)
	if c == nil {
		t.Fatal("New returned nil")
	}
	// The client should use a non-zero timeout internally (we can't inspect it
	// directly, but a cancelled context should unblock promptly).
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled
	_, err := c.GetInstance(ctx)
	if err == nil {
		t.Fatal("expected error for cancelled context, got nil")
	}
	if !strings.Contains(err.Error(), "context canceled") &&
		!strings.Contains(err.Error(), "connection refused") {
		// Either is fine — we just want to confirm it attempted the request.
		t.Logf("error (acceptable): %v", err)
	}
}
