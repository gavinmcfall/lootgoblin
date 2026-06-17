package chitu

import (
	"encoding/binary"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// BuildChunk: trailer packing + checksum
// ---------------------------------------------------------------------------

func TestBuildChunk_EmptyPayload(t *testing.T) {
	// Empty payload: XOR = 0, offset = 0, marker = 0x83
	frame := BuildChunk([]byte{}, 0)
	if len(frame) != trailerLen {
		t.Fatalf("want frame len %d, got %d", trailerLen, len(frame))
	}
	// Offset LE = 0x00 0x00 0x00 0x00
	if got := binary.LittleEndian.Uint32(frame[0:4]); got != 0 {
		t.Errorf("offset: want 0, got %d", got)
	}
	// XOR of empty = 0
	if frame[4] != 0x00 {
		t.Errorf("xor: want 0x00, got 0x%02x", frame[4])
	}
	// Marker
	if frame[5] != trailerMarker {
		t.Errorf("marker: want 0x83, got 0x%02x", frame[5])
	}
}

func TestBuildChunk_SingleByte(t *testing.T) {
	payload := []byte{0xAB}
	frame := BuildChunk(payload, 100)
	if len(frame) != 1+trailerLen {
		t.Fatalf("want len %d, got %d", 1+trailerLen, len(frame))
	}
	if frame[0] != 0xAB {
		t.Errorf("payload byte: want 0xAB, got 0x%02x", frame[0])
	}
	// Offset LE = 100
	if got := binary.LittleEndian.Uint32(frame[1:5]); got != 100 {
		t.Errorf("offset: want 100, got %d", got)
	}
	// XOR of [0xAB] = 0xAB
	if frame[5] != 0xAB {
		t.Errorf("xor: want 0xAB, got 0x%02x", frame[5])
	}
	if frame[6] != trailerMarker {
		t.Errorf("marker: want 0x83, got 0x%02x", frame[6])
	}
}

func TestBuildChunk_KnownXOR(t *testing.T) {
	// payload = [0x01, 0x02, 0x04] → XOR = 0x01^0x02^0x04 = 0x07
	payload := []byte{0x01, 0x02, 0x04}
	frame := BuildChunk(payload, 4096)

	payloadEnd := len(payload)
	if got := binary.LittleEndian.Uint32(frame[payloadEnd : payloadEnd+4]); got != 4096 {
		t.Errorf("offset: want 4096, got %d", got)
	}
	if frame[payloadEnd+4] != 0x07 {
		t.Errorf("xor: want 0x07, got 0x%02x", frame[payloadEnd+4])
	}
	if frame[payloadEnd+5] != trailerMarker {
		t.Errorf("marker: want 0x83, got 0x%02x", frame[payloadEnd+5])
	}
}

func TestBuildChunk_FullChunkSize(t *testing.T) {
	// 4096-byte payload, offset = 0 — mirrors the first chunk of a real upload.
	payload := make([]byte, defaultChunkSize)
	for i := range payload {
		payload[i] = byte(i & 0xff)
	}

	// Compute expected XOR manually.
	var expectedXOR byte
	for _, b := range payload {
		expectedXOR ^= b
	}

	frame := BuildChunk(payload, 0)
	if len(frame) != defaultChunkSize+trailerLen {
		t.Fatalf("want len %d, got %d", defaultChunkSize+trailerLen, len(frame))
	}
	// Payload intact.
	for i, b := range payload {
		if frame[i] != b {
			t.Fatalf("payload byte %d: want 0x%02x, got 0x%02x", i, b, frame[i])
		}
	}
	trailerStart := defaultChunkSize
	if got := binary.LittleEndian.Uint32(frame[trailerStart : trailerStart+4]); got != 0 {
		t.Errorf("offset: want 0, got %d", got)
	}
	if frame[trailerStart+4] != expectedXOR {
		t.Errorf("xor: want 0x%02x, got 0x%02x", expectedXOR, frame[trailerStart+4])
	}
	if frame[trailerStart+5] != trailerMarker {
		t.Errorf("marker: want 0x83, got 0x%02x", frame[trailerStart+5])
	}
}

func TestBuildChunk_LargeOffset(t *testing.T) {
	// offset = 0xDEADBEEF — verify little-endian byte order.
	const offset uint32 = 0xDEADBEEF
	payload := []byte{0xFF}
	frame := BuildChunk(payload, offset)
	trailerStart := len(payload)
	gotOffset := binary.LittleEndian.Uint32(frame[trailerStart : trailerStart+4])
	if gotOffset != offset {
		t.Errorf("offset: want 0x%08X, got 0x%08X", offset, gotOffset)
	}
}

func TestBuildChunk_PartialLastChunk(t *testing.T) {
	// Simulate a partial last chunk (e.g. 17 bytes into a file of 4113 bytes).
	payload := []byte{0x10, 0x20, 0x30}
	const fileOffset uint32 = 4110 // hypothetical partial-last-chunk start
	frame := BuildChunk(payload, fileOffset)

	trailerStart := len(payload)
	if got := binary.LittleEndian.Uint32(frame[trailerStart : trailerStart+4]); got != fileOffset {
		t.Errorf("offset: want %d, got %d", fileOffset, got)
	}
	// XOR of [0x10, 0x20, 0x30] = 0x10 ^ 0x20 ^ 0x30 = 0x20
	if frame[trailerStart+4] != (0x10 ^ 0x20 ^ 0x30) {
		t.Errorf("xor mismatch")
	}
}

// ---------------------------------------------------------------------------
// M-code commander: ok/resend handshake via net.Pipe
// ---------------------------------------------------------------------------

// fakeConn wraps net.Pipe server side and injects scripted responses.
// serverLines is consumed in order; each call to Write from the client
// triggers the next serverLine to be written back.
type pipeServer struct {
	conn    net.Conn
	lines   []string
	lineIdx int
	t       *testing.T
}

func newPipeServer(t *testing.T, lines []string) (*pipeServer, net.Conn) {
	t.Helper()
	serverSide, clientSide := net.Pipe()
	ps := &pipeServer{conn: serverSide, lines: lines, t: t}
	go ps.serve()
	return ps, clientSide
}

func (ps *pipeServer) serve() {
	buf := make([]byte, 8192)
	for ps.lineIdx < len(ps.lines) {
		// Wait for any client write (we don't inspect it in detail; the
		// commander side is verified separately via BuildChunk tests).
		n, err := ps.conn.Read(buf)
		if n == 0 || err != nil {
			return
		}
		if ps.lineIdx < len(ps.lines) {
			reply := ps.lines[ps.lineIdx]
			ps.lineIdx++
			ps.conn.Write([]byte(reply))
		}
	}
	ps.conn.Close()
}

// Wrap net.Conn to satisfy Conn interface (net.Conn already does, but
// our Conn interface requires SetDeadline which net.Conn has).
type connAdapter struct{ net.Conn }

func TestUploadAndPrint_HappyPath_StartPrint(t *testing.T) {
	// File = 2 bytes → 1 chunk.
	fileData := []byte{0xAA, 0xBB}
	filename := "test.ctb"

	// Scripted responses: M28-ok, chunk-ok, M29-ok, M6030-ok.
	_, clientConn := newPipeServer(t, []string{
		"ok\r\n",
		"ok\n",
		"ok\n",
		"ok\n",
	})

	result := uploadAndPrint("ignore", 9999, filename, fileData, true, 5000,
		func(_ string) (Conn, error) { return clientConn, nil })

	if !result.OK {
		t.Fatalf("want OK, got stage=%s reason=%s details=%s",
			result.Stage, result.Reason, result.Details)
	}
	if result.BytesSent != len(fileData) {
		t.Errorf("bytesSent: want %d, got %d", len(fileData), result.BytesSent)
	}
}

func TestUploadAndPrint_HappyPath_NoStartPrint(t *testing.T) {
	fileData := []byte{0x01, 0x02, 0x03}

	_, clientConn := newPipeServer(t, []string{
		"ok\n",
		"ok\n",
		"ok\n",
	})

	result := uploadAndPrint("ignore", 9999, "model.ctb", fileData, false, 5000,
		func(_ string) (Conn, error) { return clientConn, nil })

	if !result.OK {
		t.Fatalf("want OK, got %+v", result)
	}
}

func TestUploadAndPrint_M28Rejected(t *testing.T) {
	_, clientConn := newPipeServer(t, []string{
		"Error: file already open\n",
	})

	result := uploadAndPrint("ignore", 9999, "test.ctb", []byte{0x01}, false, 5000,
		func(_ string) (Conn, error) { return clientConn, nil })

	if result.OK {
		t.Fatal("want failure")
	}
	if result.Stage != "M28" {
		t.Errorf("stage: want M28, got %s", result.Stage)
	}
	if result.Reason != "rejected" {
		t.Errorf("reason: want rejected, got %s", result.Reason)
	}
}

func TestUploadAndPrint_ResendThenOK(t *testing.T) {
	// File = 4 bytes → 1 chunk; printer asks for resend at 0, then ok.
	fileData := []byte{0x01, 0x02, 0x03, 0x04}

	_, clientConn := newPipeServer(t, []string{
		"ok\n",       // M28
		"resend 0\n", // chunk: resend from start
		"ok\n",       // chunk: ok after resend
		"ok\n",       // M29
		// no M6030 (startPrint=false)
	})

	result := uploadAndPrint("ignore", 9999, "test.ctb", fileData, false, 5000,
		func(_ string) (Conn, error) { return clientConn, nil })

	if !result.OK {
		t.Fatalf("want OK after resend, got %+v", result)
	}
}

func TestUploadAndPrint_ResendLimitExceeded(t *testing.T) {
	fileData := []byte{0x01, 0x02, 0x03}

	// resend 4 times — exceeds defaultMaxResendRetry=3.
	_, clientConn := newPipeServer(t, []string{
		"ok\n",       // M28
		"resend 0\n", // 1st resend
		"resend 0\n", // 2nd resend
		"resend 0\n", // 3rd resend
		"resend 0\n", // 4th resend → should fail
	})

	result := uploadAndPrint("ignore", 9999, "test.ctb", fileData, false, 5000,
		func(_ string) (Conn, error) { return clientConn, nil })

	if result.OK {
		t.Fatal("want failure after resend limit exceeded")
	}
	if result.Stage != "upload" {
		t.Errorf("stage: want upload, got %s", result.Stage)
	}
	if result.Reason != "rejected" {
		t.Errorf("reason: want rejected, got %s", result.Reason)
	}
	if !strings.Contains(result.Details, "retry limit") {
		t.Errorf("details should mention retry limit, got %q", result.Details)
	}
}

func TestUploadAndPrint_DialFail(t *testing.T) {
	result := uploadAndPrint("10.0.0.1", 3000, "test.ctb", []byte{0x01}, false, 5000,
		func(_ string) (Conn, error) {
			return nil, fmt.Errorf("connection refused")
		})

	if result.OK {
		t.Fatal("want failure on dial error")
	}
	if result.Stage != "connect" {
		t.Errorf("stage: want connect, got %s", result.Stage)
	}
	if result.Reason != "unreachable" {
		t.Errorf("reason: want unreachable, got %s", result.Reason)
	}
}

func TestUploadAndPrint_M29Rejected(t *testing.T) {
	fileData := []byte{0x01}

	_, clientConn := newPipeServer(t, []string{
		"ok\n",
		"ok\n",   // chunk
		"fail\n", // M29 rejected
	})

	result := uploadAndPrint("ignore", 9999, "test.ctb", fileData, false, 5000,
		func(_ string) (Conn, error) { return clientConn, nil })

	if result.OK {
		t.Fatal("want failure on M29 rejected")
	}
	if result.Stage != "M29" {
		t.Errorf("stage: want M29, got %s", result.Stage)
	}
}

// Verify that readLine correctly strips trailing \r before \n.
func TestReadLine_CRLF(t *testing.T) {
	serverSide, clientSide := net.Pipe()
	go func() {
		serverSide.Write([]byte("ok\r\n"))
		serverSide.Close()
	}()

	// Give the goroutine a moment to write.
	clientSide.SetDeadline(time.Now().Add(2 * time.Second))
	line, err := readLine(clientSide)
	if err != nil {
		t.Fatalf("readLine: %v", err)
	}
	if line != "ok" {
		t.Errorf("want %q, got %q", "ok", line)
	}
}
