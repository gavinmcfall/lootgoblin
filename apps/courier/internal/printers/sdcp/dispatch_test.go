package sdcp

import (
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func tempCtbFile(t *testing.T, name string, sizeBytes int) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, name)
	data := make([]byte, sizeBytes)
	for i := range data {
		data[i] = byte(i % 251)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatalf("tempCtbFile: %v", err)
	}
	return p
}

// fakeUploadServer returns a test server that accepts uploads and returns 200.
// It records how many POSTs arrive.
func fakeUploadServer(t *testing.T) (*httptest.Server, *int) {
	t.Helper()
	count := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/uploadFile/upload", func(w http.ResponseWriter, r *http.Request) {
		// Drain the body so the HTTP client gets a clean response.
		_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		mr := multipart.NewReader(r.Body, params["boundary"])
		for {
			p, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				break
			}
			io.Copy(io.Discard, p)
		}
		count++
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &count
}

func cfgForUploadSrv(t *testing.T, srv *httptest.Server) ConnectionConfig {
	t.Helper()
	u := srv.URL
	trimmed := strings.TrimPrefix(u, "http://")
	parts := strings.SplitN(trimmed, ":", 2)
	if len(parts) != 2 {
		t.Fatalf("bad server URL: %s", u)
	}
	port, _ := strconv.Atoi(parts[1])
	return ConnectionConfig{
		IP:          parts[0],
		MainboardID: "DISPATCH_BOARD",
		Port:        port,
		StartPrint:  false, // upload-only so we don't need a WS server
		StartLayer:  0,
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestDispatch_NonCtb_Rejected(t *testing.T) {
	p := filepath.Join(t.TempDir(), "model.gcode")
	_ = os.WriteFile(p, []byte("G0 X0\n"), 0o644)

	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD", Port: 3030}
	result := Dispatch(bg(), cfg, p, nil, nil)
	if result.OK {
		t.Fatal("expected failure for non-.ctb file")
	}
	if result.Reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", result.Reason)
	}
	if !strings.Contains(result.Details, ".ctb") {
		t.Errorf("expected .ctb in details, got %q", result.Details)
	}
}

func TestDispatch_FileReadError(t *testing.T) {
	cfg := ConnectionConfig{IP: "127.0.0.1", MainboardID: "BOARD", Port: 3030}
	result := Dispatch(bg(), cfg, "/tmp/nonexistent_sdcp_artifact.ctb", nil, nil)
	if result.OK {
		t.Fatal("expected failure for missing file")
	}
	if result.Reason != "unknown" {
		t.Errorf("want reason=unknown, got %s", result.Reason)
	}
}

func TestDispatch_UploadOnly_Success(t *testing.T) {
	srv, count := fakeUploadServer(t)
	p := tempCtbFile(t, "print.ctb", 512*1024)
	cfg := cfgForUploadSrv(t, srv)
	cfg.StartPrint = false

	result := Dispatch(bg(), cfg, p, nil, nil)
	if !result.OK {
		t.Fatalf("expected OK, got reason=%s details=%s", result.Reason, result.Details)
	}
	if result.RemoteFilename != "/local/print.ctb" {
		t.Errorf("remoteFilename: want /local/print.ctb, got %q", result.RemoteFilename)
	}
	if *count == 0 {
		t.Error("expected at least one chunk POST")
	}
}

func TestDispatch_UploadFails_Returns_UploadReason(t *testing.T) {
	// Server that returns 400 to simulate printer rejecting the chunk.
	mux := http.NewServeMux()
	mux.HandleFunc("/uploadFile/upload", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad request", http.StatusBadRequest)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := tempCtbFile(t, "fail.ctb", 1024)
	cfg := cfgForUploadSrv(t, srv)

	result := Dispatch(bg(), cfg, p, nil, nil)
	if result.OK {
		t.Fatal("expected failure")
	}
	if result.Reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", result.Reason)
	}
	if !strings.Contains(result.Details, "upload failed") {
		t.Errorf("expected 'upload failed' in details, got %q", result.Details)
	}
}

func TestDispatch_ParseConfig_MissingIP(t *testing.T) {
	// adapter.Dispatch path: bad config JSON → unknown reason.
	a := adapter{}
	outcome := a.Dispatch(bg(), []byte(`{"mainboardId":"BOARD"}`), []byte(`{}`), "/tmp/x.ctb", nil)
	if outcome.OK {
		t.Fatal("expected failure for missing ip")
	}
	if outcome.Reason != "unknown" {
		t.Errorf("want reason=unknown, got %s", outcome.Reason)
	}
}

func TestDispatch_ParseConfig_MissingMainboardId(t *testing.T) {
	a := adapter{}
	outcome := a.Dispatch(bg(), []byte(`{"ip":"127.0.0.1"}`), []byte(`{}`), "/tmp/x.ctb", nil)
	if outcome.OK {
		t.Fatal("expected failure for missing mainboardId")
	}
	if outcome.Reason != "unknown" {
		t.Errorf("want reason=unknown, got %s", outcome.Reason)
	}
}

func TestDispatch_ParseConfig_Defaults(t *testing.T) {
	cfg, err := ParseConnectionConfig([]byte(`{"ip":"192.168.1.1","mainboardId":"BOARD"}`))
	if err != nil {
		t.Fatalf("ParseConnectionConfig: %v", err)
	}
	if cfg.Port != 3030 {
		t.Errorf("default port: want 3030, got %d", cfg.Port)
	}
	if !cfg.StartPrint {
		t.Error("default startPrint: want true")
	}
	if cfg.StartLayer != 0 {
		t.Errorf("default startLayer: want 0, got %d", cfg.StartLayer)
	}
}
