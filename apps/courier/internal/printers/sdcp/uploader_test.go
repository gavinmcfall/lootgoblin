package sdcp

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// chunkRecord records the multipart fields received in one POST to /uploadFile/upload.
type chunkRecord struct {
	sFileMD5  string
	check     string
	offset    int
	uuid      string
	totalSize int
	fileBytes []byte
	filename  string
}

// fakeSDCPUploadServer starts an httptest.Server that captures all chunk POSTs
// to /uploadFile/upload. It returns 200 OK for each.
func fakeSDCPUploadServer(t *testing.T) (*httptest.Server, *[]chunkRecord) {
	t.Helper()
	var records []chunkRecord

	mux := http.NewServeMux()
	mux.HandleFunc("/uploadFile/upload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		cr := parseChunkRequest(t, r)
		records = append(records, cr)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &records
}

func parseChunkRequest(t *testing.T, r *http.Request) chunkRecord {
	t.Helper()
	_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("parseChunkRequest: bad Content-Type: %v", err)
	}
	mr := multipart.NewReader(r.Body, params["boundary"])
	var cr chunkRecord
	for {
		part, partErr := mr.NextPart()
		if partErr == io.EOF {
			break
		}
		if partErr != nil {
			t.Fatalf("parseChunkRequest: read part: %v", partErr)
		}
		data, _ := io.ReadAll(part)
		switch part.FormName() {
		case "S-File-MD5":
			cr.sFileMD5 = string(data)
		case "Check":
			cr.check = string(data)
		case "Offset":
			v, _ := strconv.Atoi(string(data))
			cr.offset = v
		case "Uuid":
			cr.uuid = string(data)
		case "TotalSize":
			v, _ := strconv.Atoi(string(data))
			cr.totalSize = v
		case "File":
			cr.fileBytes = data
			cr.filename = part.FileName()
		}
	}
	return cr
}

// makeTestData returns a byte slice of the given length filled with a repeating pattern.
func makeTestData(size int) []byte {
	b := make([]byte, size)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}

// md5Hex computes the hex-encoded MD5 of b.
func md5Hex(b []byte) string {
	sum := md5.Sum(b)
	return hex.EncodeToString(sum[:])
}

// cfgFromServer extracts host+port from an httptest.Server URL and builds a ConnectionConfig.
func cfgFromServer(t *testing.T, srv *httptest.Server) ConnectionConfig {
	t.Helper()
	u := srv.URL // http://127.0.0.1:PORT
	trimmed := strings.TrimPrefix(u, "http://")
	parts := strings.SplitN(trimmed, ":", 2)
	if len(parts) != 2 {
		t.Fatalf("cannot parse server URL: %s", u)
	}
	port, err := strconv.Atoi(parts[1])
	if err != nil {
		t.Fatalf("cannot parse port from %q: %v", parts[1], err)
	}
	return ConnectionConfig{
		IP:          parts[0],
		MainboardID: "TESTBOARD01",
		Port:        port,
		StartPrint:  true,
		StartLayer:  0,
	}
}

func bg() context.Context { return context.Background() }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestUploadFileChunked_SingleChunk(t *testing.T) {
	srv, records := fakeSDCPUploadServer(t)

	// 512 KiB — fits in one chunk.
	data := makeTestData(512 * 1024)
	cfg := cfgFromServer(t, srv)

	result := uploadFileChunked(bg(), cfg, data, "model.ctb", "test-uuid-1", nil, nil)
	if !result.OK {
		t.Fatalf("expected OK, got reason=%s details=%s", result.Reason, result.Details)
	}
	recs := *records
	if len(recs) != 1 {
		t.Fatalf("want 1 chunk, got %d", len(recs))
	}
	cr := recs[0]

	if cr.check != "1" {
		t.Errorf("Check: want '1', got %q", cr.check)
	}
	if cr.offset != 0 {
		t.Errorf("Offset: want 0, got %d", cr.offset)
	}
	if cr.uuid != "test-uuid-1" {
		t.Errorf("Uuid: want test-uuid-1, got %q", cr.uuid)
	}
	if cr.totalSize != len(data) {
		t.Errorf("TotalSize: want %d, got %d", len(data), cr.totalSize)
	}
	if cr.filename != "model.ctb" {
		t.Errorf("filename: want model.ctb, got %q", cr.filename)
	}
	want := md5Hex(data)
	if cr.sFileMD5 != want {
		t.Errorf("S-File-MD5: want %s, got %s", want, cr.sFileMD5)
	}
	if result.MD5Hex != want {
		t.Errorf("result.MD5Hex: want %s, got %s", want, result.MD5Hex)
	}
}

func TestUploadFileChunked_MultipleChunks(t *testing.T) {
	srv, records := fakeSDCPUploadServer(t)

	// 2.5 MiB → 3 chunks (1 MiB + 1 MiB + 0.5 MiB).
	data := makeTestData(2*1024*1024 + 512*1024)
	cfg := cfgFromServer(t, srv)

	result := uploadFileChunked(bg(), cfg, data, "large.ctb", "uuid-multi", nil, nil)
	if !result.OK {
		t.Fatalf("expected OK, got reason=%s details=%s", result.Reason, result.Details)
	}

	recs := *records
	if len(recs) != 3 {
		t.Fatalf("want 3 chunks, got %d", len(recs))
	}

	// All chunks share the same MD5, Uuid, TotalSize.
	wantMD5 := md5Hex(data)
	for i, cr := range recs {
		if cr.sFileMD5 != wantMD5 {
			t.Errorf("chunk %d: S-File-MD5 want %s, got %s", i, wantMD5, cr.sFileMD5)
		}
		if cr.uuid != "uuid-multi" {
			t.Errorf("chunk %d: Uuid changed, got %s", i, cr.uuid)
		}
		if cr.totalSize != len(data) {
			t.Errorf("chunk %d: TotalSize want %d, got %d", i, len(data), cr.totalSize)
		}
	}

	// Check: '1' on first, '0' on rest.
	if recs[0].check != "1" {
		t.Errorf("chunk 0: Check want '1', got %q", recs[0].check)
	}
	for i := 1; i < len(recs); i++ {
		if recs[i].check != "0" {
			t.Errorf("chunk %d: Check want '0', got %q", i, recs[i].check)
		}
	}

	// Offsets.
	expectedOffsets := []int{0, defaultChunkSize, 2 * defaultChunkSize}
	for i, cr := range recs {
		if cr.offset != expectedOffsets[i] {
			t.Errorf("chunk %d: Offset want %d, got %d", i, expectedOffsets[i], cr.offset)
		}
	}

	if result.BytesSent != len(data) {
		t.Errorf("BytesSent: want %d, got %d", len(data), result.BytesSent)
	}
}

func TestUploadFileChunked_MD5Correctness(t *testing.T) {
	srv, records := fakeSDCPUploadServer(t)

	data := makeTestData(300 * 1024) // 300 KiB
	cfg := cfgFromServer(t, srv)

	result := uploadFileChunked(bg(), cfg, data, "test.ctb", "uuid-md5", nil, nil)
	if !result.OK {
		t.Fatalf("upload failed: %s %s", result.Reason, result.Details)
	}
	if len(*records) == 0 {
		t.Fatal("no chunks recorded")
	}

	want := md5Hex(data)
	if result.MD5Hex != want {
		t.Errorf("result.MD5Hex=%s want %s", result.MD5Hex, want)
	}
	for i, cr := range *records {
		if cr.sFileMD5 != want {
			t.Errorf("chunk %d: S-File-MD5=%s want %s", i, cr.sFileMD5, want)
		}
	}
}

func TestUploadFileChunked_HTTPError4xx(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/uploadFile/upload", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad chunk", http.StatusBadRequest)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cfg := cfgFromServer(t, srv)
	data := makeTestData(1024)
	result := uploadFileChunked(bg(), cfg, data, "test.ctb", "uuid-4xx", nil, nil)
	if result.OK {
		t.Fatal("expected failure on 400")
	}
	if result.Reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", result.Reason)
	}
}

func TestUploadFileChunked_HTTPError5xx(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/uploadFile/upload", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "server error", http.StatusInternalServerError)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cfg := cfgFromServer(t, srv)
	data := makeTestData(1024)
	result := uploadFileChunked(bg(), cfg, data, "test.ctb", "uuid-5xx", nil, nil)
	if result.OK {
		t.Fatal("expected failure on 500")
	}
	if result.Reason != "unknown" {
		t.Errorf("want reason=unknown, got %s", result.Reason)
	}
}

func TestUploadFileChunked_Unreachable(t *testing.T) {
	// Use a server that immediately closes the connection to trigger
	// a net.OpError (connection reset) rather than waiting for a timeout.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hijack and close immediately to force a connection-reset error.
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", 500)
			return
		}
		conn, _, _ := hj.Hijack()
		conn.Close()
	}))
	defer srv.Close()

	cfg := cfgFromServer(t, srv)
	data := makeTestData(512)
	// Use a very short timeout so the test doesn't hang.
	shortClient := &http.Client{Timeout: 2 * time.Second}
	result := uploadFileChunked(bg(), cfg, data, "test.ctb", "uuid-unr", shortClient, nil)
	if result.OK {
		t.Fatal("expected failure on reset connection")
	}
	// After a connection reset, the error is a net.OpError → "unreachable".
	// Accept either "unreachable" or "unknown" since Go's HTTP stack may
	// classify connection-reset differently on some platforms.
	if result.Reason != "unreachable" && result.Reason != "unknown" {
		t.Errorf("want reason=unreachable or unknown, got %s", result.Reason)
	}
}
