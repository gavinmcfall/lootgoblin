// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package octoprint

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

var discardLog = slog.New(slog.NewTextHandler(io.Discard, nil))

// tempGcode creates a temporary .gcode file with the given content and returns
// its path. The file is cleaned up via t.Cleanup.
func tempGcode(t *testing.T, name, content string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("tempGcode: write: %v", err)
	}
	return p
}

// parseMultipart reads multipart fields from a POST request and returns a map
// of field name → value and the raw filename for the "file" part.
func parseMultipart(t *testing.T, r *http.Request) (fields map[string]string, fileField string, fileBytes []byte) {
	t.Helper()
	_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("parseMultipart: bad Content-Type: %v", err)
	}
	boundary := params["boundary"]
	mr := multipart.NewReader(r.Body, boundary)
	fields = make(map[string]string)

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("parseMultipart: next part: %v", err)
		}
		data, _ := io.ReadAll(part)
		if fn := part.FileName(); fn != "" {
			fileField = fn
			fileBytes = data
		} else {
			fields[part.FormName()] = string(data)
		}
	}
	return
}

// defaultCfg returns a ConnectionConfig pointing at the supplied host:port with
// all other fields at their defaults (requiresAuth=true, select=true, startPrint=true, scheme=http).
func defaultCfg(host string, port int) ConnectionConfig {
	return ConnectionConfig{
		Host:         host,
		Port:         port,
		Scheme:       "http",
		APIPath:      "/api",
		Select:       true,
		StartPrint:   true,
		RequiresAuth: true,
	}
}

// hostPort extracts host + int port from an httptest server URL.
func hostPort(t *testing.T, serverURL string) (string, int) {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(serverURL, "http://"))
	port := 0
	fmt.Sscanf(portStr, "%d", &port)
	return host, port
}

// ---------------------------------------------------------------------------
// ParseConnectionConfig
// ---------------------------------------------------------------------------

func TestParseConnectionConfig_Defaults(t *testing.T) {
	raw := json.RawMessage(`{"host":"octoprint.local"}`)
	cfg, err := ParseConnectionConfig(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Host != "octoprint.local" {
		t.Errorf("host: got %q, want %q", cfg.Host, "octoprint.local")
	}
	if cfg.Port != 80 {
		t.Errorf("port: got %d, want 80", cfg.Port)
	}
	if cfg.Scheme != "http" {
		t.Errorf("scheme: got %q, want \"http\"", cfg.Scheme)
	}
	if cfg.APIPath != "/api" {
		t.Errorf("apiPath: got %q, want \"/api\"", cfg.APIPath)
	}
	if !cfg.Select {
		t.Errorf("select: got false, want true")
	}
	if !cfg.StartPrint {
		t.Errorf("startPrint: got false, want true")
	}
	if !cfg.RequiresAuth {
		t.Errorf("requiresAuth: got false, want true")
	}
}

func TestParseConnectionConfig_Overrides(t *testing.T) {
	raw := json.RawMessage(`{"host":"printer","port":8080,"scheme":"https","apiPath":"/octoprint/api","select":false,"startPrint":false,"requiresAuth":false}`)
	cfg, err := ParseConnectionConfig(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 8080 {
		t.Errorf("port: got %d, want 8080", cfg.Port)
	}
	if cfg.Scheme != "https" {
		t.Errorf("scheme: got %q", cfg.Scheme)
	}
	if cfg.APIPath != "/octoprint/api" {
		t.Errorf("apiPath: got %q, want \"/octoprint/api\"", cfg.APIPath)
	}
	if cfg.Select {
		t.Errorf("select: got true, want false")
	}
	if cfg.StartPrint {
		t.Errorf("startPrint: got true, want false")
	}
	if cfg.RequiresAuth {
		t.Errorf("requiresAuth: got true, want false")
	}
}

func TestParseConnectionConfig_MissingHost(t *testing.T) {
	raw := json.RawMessage(`{"port":80}`)
	_, err := ParseConnectionConfig(raw)
	if err == nil {
		t.Fatal("expected error for missing host, got nil")
	}
}

func TestParseConnectionConfig_BadScheme(t *testing.T) {
	raw := json.RawMessage(`{"host":"x","scheme":"ftp"}`)
	_, err := ParseConnectionConfig(raw)
	if err == nil {
		t.Fatal("expected error for bad scheme")
	}
}

func TestParseConnectionConfig_InvalidJSON(t *testing.T) {
	raw := json.RawMessage(`not-json`)
	_, err := ParseConnectionConfig(raw)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

// ---------------------------------------------------------------------------
// ParseCredential
// ---------------------------------------------------------------------------

func TestParseCredential_WithKey(t *testing.T) {
	raw := json.RawMessage(`{"apiKey":"abc123"}`)
	cred, err := ParseCredential(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cred.APIKey != "abc123" {
		t.Errorf("apiKey: got %q, want \"abc123\"", cred.APIKey)
	}
}

func TestParseCredential_NilRaw(t *testing.T) {
	cred, err := ParseCredential(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cred.APIKey != "" {
		t.Errorf("expected empty apiKey, got %q", cred.APIKey)
	}
}

func TestParseCredential_EmptyRaw(t *testing.T) {
	cred, err := ParseCredential(json.RawMessage(""))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cred.APIKey != "" {
		t.Errorf("expected empty apiKey, got %q", cred.APIKey)
	}
}

func TestParseCredential_NullRaw(t *testing.T) {
	cred, err := ParseCredential(json.RawMessage("null"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cred.APIKey != "" {
		t.Errorf("expected empty apiKey for null, got %q", cred.APIKey)
	}
}

// ---------------------------------------------------------------------------
// Dispatch — success paths
// ---------------------------------------------------------------------------

func TestDispatch_SuccessWithRemoteFilename(t *testing.T) {
	const apiKey = "secret-key"
	const gcodeContent = "G28\nG1 Z10\n"

	var capturedAPIKey string
	var capturedFields map[string]string
	var capturedFilename string
	var capturedFileBytes []byte
	var capturedURL string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedURL = r.URL.Path
		capturedAPIKey = r.Header.Get("X-Api-Key")
		capturedFields, capturedFilename, capturedFileBytes = parseMultipart(t, r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"files":{"local":{"path":"foo.gcode"}}}`)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "foo.gcode", gcodeContent)
	host, port := hostPort(t, srv.URL)

	cfg := defaultCfg(host, port)
	cred := &Credential{APIKey: apiKey}

	out := Dispatch(context.Background(), cfg, cred, artifactPath, nil, discardLog)

	if !out.OK {
		t.Fatalf("expected OK=true, got reason=%q details=%q", out.Reason, out.Details)
	}
	if out.RemoteFilename != "foo.gcode" {
		t.Errorf("RemoteFilename: got %q, want \"foo.gcode\"", out.RemoteFilename)
	}

	// Assert URL path contains /api/files/local
	if capturedURL != "/api/files/local" {
		t.Errorf("URL path: got %q, want \"/api/files/local\"", capturedURL)
	}

	// Assert multipart fields
	if capturedFields["select"] != "true" {
		t.Errorf("select field: got %q, want \"true\"", capturedFields["select"])
	}
	if capturedFields["print"] != "true" {
		t.Errorf("print field: got %q, want \"true\"", capturedFields["print"])
	}
	if capturedFilename != "foo.gcode" {
		t.Errorf("file filename: got %q, want \"foo.gcode\"", capturedFilename)
	}
	if string(capturedFileBytes) != gcodeContent {
		t.Errorf("file bytes: got %q, want %q", string(capturedFileBytes), gcodeContent)
	}
	if capturedAPIKey != apiKey {
		t.Errorf("X-Api-Key: got %q, want %q", capturedAPIKey, apiKey)
	}
}

func TestDispatch_SuccessStatus201(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprint(w, `{"files":{"local":{"path":"bar.gcode"}}}`)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "bar.gcode", "G28\n")
	host, port := hostPort(t, srv.URL)

	cfg := defaultCfg(host, port)
	cred := &Credential{APIKey: "key"}

	out := Dispatch(context.Background(), cfg, cred, artifactPath, nil, discardLog)
	if !out.OK {
		t.Fatalf("expected OK=true for 201, got reason=%q", out.Reason)
	}
	if out.RemoteFilename != "bar.gcode" {
		t.Errorf("RemoteFilename: got %q", out.RemoteFilename)
	}
}

func TestDispatch_SuccessNoJSONFallsBackToBasename(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `not-valid-json`)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "myjob.gcode", "G28\n")
	host, port := hostPort(t, srv.URL)

	cfg := defaultCfg(host, port)
	cred := &Credential{APIKey: "key"}

	out := Dispatch(context.Background(), cfg, cred, artifactPath, nil, discardLog)
	if !out.OK {
		t.Fatalf("expected OK=true, got reason=%q", out.Reason)
	}
	if out.RemoteFilename != "myjob.gcode" {
		t.Errorf("RemoteFilename: got %q, want \"myjob.gcode\"", out.RemoteFilename)
	}
}

func TestDispatch_SelectFalse_PrintFalse(t *testing.T) {
	var capturedSelect, capturedPrint string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fields, _, _ := parseMultipart(t, r)
		capturedSelect = fields["select"]
		capturedPrint = fields["print"]
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"files":{"local":{"path":"x.gcode"}}}`)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "x.gcode", "G28\n")
	host, port := hostPort(t, srv.URL)

	cfg := ConnectionConfig{
		Host:         host,
		Port:         port,
		Scheme:       "http",
		APIPath:      "/api",
		Select:       false,
		StartPrint:   false,
		RequiresAuth: true,
	}
	cred := &Credential{APIKey: "key"}

	out := Dispatch(context.Background(), cfg, cred, artifactPath, nil, discardLog)
	if !out.OK {
		t.Fatalf("expected OK=true")
	}
	if capturedSelect != "false" {
		t.Errorf("select field: got %q, want \"false\"", capturedSelect)
	}
	if capturedPrint != "false" {
		t.Errorf("print field: got %q, want \"false\"", capturedPrint)
	}
}

func TestDispatch_CustomAPIPath(t *testing.T) {
	var capturedPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"files":{"local":{"path":"ok.gcode"}}}`)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "ok.gcode", "G28\n")
	host, port := hostPort(t, srv.URL)

	cfg := ConnectionConfig{
		Host:         host,
		Port:         port,
		Scheme:       "http",
		APIPath:      "/octoprint/api",
		Select:       true,
		StartPrint:   true,
		RequiresAuth: false,
	}

	out := Dispatch(context.Background(), cfg, nil, artifactPath, nil, discardLog)
	if !out.OK {
		t.Fatalf("expected OK=true, got reason=%q", out.Reason)
	}
	if capturedPath != "/octoprint/api/files/local" {
		t.Errorf("URL path: got %q, want \"/octoprint/api/files/local\"", capturedPath)
	}
}

// ---------------------------------------------------------------------------
// Dispatch — no-credentials guard
// ---------------------------------------------------------------------------

func TestDispatch_NilCredRequiresAuth_NoNetworkCall(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("no-credentials guard: server was unexpectedly called")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "z.gcode", "G28\n")
	host, port := hostPort(t, srv.URL)

	cfg := defaultCfg(host, port) // requiresAuth=true
	out := Dispatch(context.Background(), cfg, nil, artifactPath, nil, discardLog)

	if out.OK {
		t.Fatal("expected OK=false")
	}
	if out.Reason != "no-credentials" {
		t.Errorf("reason: got %q, want \"no-credentials\"", out.Reason)
	}
}

func TestDispatch_EmptyAPIKeyRequiresAuth_NoNetworkCall(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("no-credentials guard: server was unexpectedly called (empty key)")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "z.gcode", "G28\n")
	host, port := hostPort(t, srv.URL)

	cfg := defaultCfg(host, port)
	cred := &Credential{APIKey: ""}
	out := Dispatch(context.Background(), cfg, cred, artifactPath, nil, discardLog)

	if out.Reason != "no-credentials" {
		t.Errorf("reason: got %q, want \"no-credentials\"", out.Reason)
	}
}

// ---------------------------------------------------------------------------
// Dispatch — HTTP error status codes
// ---------------------------------------------------------------------------

func statusTest(t *testing.T, status int, wantReason string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "err.gcode", "G28\n")
	host, port := hostPort(t, srv.URL)

	cfg := defaultCfg(host, port)
	cred := &Credential{APIKey: "key"}
	out := Dispatch(context.Background(), cfg, cred, artifactPath, nil, discardLog)

	if out.OK {
		t.Errorf("status %d: expected OK=false", status)
	}
	if out.Reason != wantReason {
		t.Errorf("status %d: reason got %q, want %q", status, out.Reason, wantReason)
	}
}

func TestDispatch_401_AuthFailed(t *testing.T) { statusTest(t, 401, "auth-failed") }
func TestDispatch_403_AuthFailed(t *testing.T) { statusTest(t, 403, "auth-failed") }
func TestDispatch_400_Rejected(t *testing.T)   { statusTest(t, 400, "rejected") }
func TestDispatch_422_Rejected(t *testing.T)   { statusTest(t, 422, "rejected") }
func TestDispatch_500_Unknown(t *testing.T)    { statusTest(t, 500, "unknown") }
func TestDispatch_503_Unknown(t *testing.T)    { statusTest(t, 503, "unknown") }

// ---------------------------------------------------------------------------
// Dispatch — network errors
// ---------------------------------------------------------------------------

func TestDispatch_Unreachable_ClosedPort(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := l.Addr().String()
	l.Close()

	artifactPath := tempGcode(t, "unreachable.gcode", "G28\n")
	host, portStr, _ := net.SplitHostPort(addr)
	port := 0
	fmt.Sscanf(portStr, "%d", &port)

	cfg := defaultCfg(host, port)
	cred := &Credential{APIKey: "key"}
	out := Dispatch(context.Background(), cfg, cred, artifactPath, nil, discardLog)

	if out.OK {
		t.Fatal("expected OK=false")
	}
	if out.Reason != "unreachable" {
		t.Errorf("reason: got %q, want \"unreachable\"", out.Reason)
	}
}

func TestDispatch_Unreachable_InvalidHost(t *testing.T) {
	artifactPath := tempGcode(t, "nxdomain.gcode", "G28\n")
	cfg := ConnectionConfig{
		Host:         "this-host-does-not-exist.invalid",
		Port:         80,
		Scheme:       "http",
		APIPath:      "/api",
		StartPrint:   true,
		RequiresAuth: false, // skip no-creds guard
	}
	out := Dispatch(context.Background(), cfg, nil, artifactPath, nil, discardLog)

	if out.OK {
		t.Fatal("expected OK=false")
	}
	if out.Reason != "unreachable" {
		t.Errorf("reason: got %q, want \"unreachable\"", out.Reason)
	}
}

// ---------------------------------------------------------------------------
// Dispatch — timeout
// ---------------------------------------------------------------------------

func TestDispatch_Timeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "timeout.gcode", "G28\n")
	host, port := hostPort(t, srv.URL)

	cfg := defaultCfg(host, port)
	cred := &Credential{APIKey: "key"}

	shortClient := &http.Client{Timeout: 50 * time.Millisecond}
	out := Dispatch(context.Background(), cfg, cred, artifactPath, shortClient, discardLog)

	if out.OK {
		t.Fatal("expected OK=false")
	}
	if out.Reason != "timeout" {
		t.Errorf("reason: got %q, want \"timeout\"", out.Reason)
	}
}

// ---------------------------------------------------------------------------
// Dispatch — no X-Api-Key when requiresAuth=false and no cred
// ---------------------------------------------------------------------------

func TestDispatch_RequiresAuthFalse_NoAPIKeyHeader(t *testing.T) {
	var capturedKey string
	var received bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = true
		capturedKey = r.Header.Get("X-Api-Key")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"files":{"local":{"path":"ok.gcode"}}}`)
	}))
	defer srv.Close()

	artifactPath := tempGcode(t, "ok.gcode", "G28\n")
	host, port := hostPort(t, srv.URL)

	cfg := ConnectionConfig{
		Host:         host,
		Port:         port,
		Scheme:       "http",
		APIPath:      "/api",
		Select:       true,
		StartPrint:   true,
		RequiresAuth: false,
	}
	out := Dispatch(context.Background(), cfg, nil, artifactPath, nil, discardLog)

	if !out.OK {
		t.Fatalf("expected OK=true, got reason=%q", out.Reason)
	}
	if !received {
		t.Fatal("server was not called")
	}
	if capturedKey != "" {
		t.Errorf("X-Api-Key should not be set, got %q", capturedKey)
	}
}
