// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package chitu

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

const (
	defaultChunkSize      = 4096
	defaultMaxResendRetry = 3
	trailerLen            = 6
	trailerMarker         = 0x83
)

// ---------------------------------------------------------------------------
// Conn abstraction — injectable for tests
// ---------------------------------------------------------------------------

// Conn is the minimal net.Conn surface used by the commander.
// net.Conn satisfies this interface; tests can use net.Pipe().
type Conn interface {
	io.Reader
	io.Writer
	io.Closer
	SetDeadline(t time.Time) error
}

// ---------------------------------------------------------------------------
// Pure trailer builder
// ---------------------------------------------------------------------------

// BuildChunk appends the 6-byte trailer to payload and returns the full frame.
//
// Trailer layout (6 bytes):
//
//	bytes 0..3 — uint32 little-endian absolute file offset of this chunk's start
//	byte  4    — XOR-fold of all payload bytes (single byte)
//	byte  5    — literal 0x83 marker
//
// This is the highest-risk code in the package — the byte layout is verified
// by TestBuildChunk in commander_test.go.
func BuildChunk(payload []byte, offset uint32) []byte {
	frame := make([]byte, len(payload)+trailerLen)
	copy(frame, payload)

	t := frame[len(payload):]
	binary.LittleEndian.PutUint32(t[0:4], offset)

	var xor byte
	for _, b := range payload {
		xor ^= b
	}
	t[4] = xor
	t[5] = trailerMarker
	return frame
}

// ---------------------------------------------------------------------------
// Line-buffered ACK reader
// ---------------------------------------------------------------------------

// readLine reads bytes from conn until '\n', returning the line without the
// trailing '\n' (and stripping any leading '\r'). Respects the deadline already
// set on conn by the caller.
func readLine(conn Conn) (string, error) {
	var buf []byte
	single := make([]byte, 1)
	for {
		_, err := conn.Read(single)
		if err != nil {
			return "", err
		}
		b := single[0]
		if b == '\n' {
			line := string(buf)
			line = strings.TrimRight(line, "\r")
			return line, nil
		}
		buf = append(buf, b)
	}
}

// ---------------------------------------------------------------------------
// uploadAndPrint
// ---------------------------------------------------------------------------

// UploadResult is the result of uploadAndPrint.
type UploadResult struct {
	OK        bool
	Reason    string // unreachable | rejected | timeout | unknown
	Stage     string // connect | M28 | upload | M29 | M6030
	Details   string
	BytesSent int
}

// uploadAndPrint drives the M-code TCP sequence to upload fileData to the
// printer and optionally start a print.
//
// dialFn is injectable for tests; pass nil to use net.Dial.
func uploadAndPrint(
	ip string,
	port int,
	filename string,
	fileData []byte,
	startPrint bool,
	stageTimeoutMs int,
	dialFn func(addr string) (Conn, error),
) UploadResult {
	if dialFn == nil {
		dialFn = func(addr string) (Conn, error) {
			return net.DialTimeout("tcp", addr, 10*time.Second)
		}
	}

	addr := fmt.Sprintf("%s:%d", ip, port)
	conn, err := dialFn(addr)
	if err != nil {
		return UploadResult{
			Reason:  "unreachable",
			Stage:   "connect",
			Details: err.Error(),
		}
	}
	defer conn.Close()

	timeout := time.Duration(stageTimeoutMs) * time.Millisecond
	totalSize := len(fileData)
	bytesSent := 0

	setDeadline := func() error {
		return conn.SetDeadline(time.Now().Add(timeout))
	}

	failErr := func(stage string, err error) UploadResult {
		msg := err.Error()
		var reason string
		switch {
		case isTimeout(err) || strings.Contains(msg, "timeout"):
			reason = "timeout"
		case isNetworkErr(msg):
			reason = "unreachable"
		default:
			reason = "unknown"
		}
		return UploadResult{
			Reason:    reason,
			Stage:     stage,
			Details:   msg,
			BytesSent: bytesSent,
		}
	}

	failRejected := func(stage, details string) UploadResult {
		return UploadResult{
			Reason:    "rejected",
			Stage:     stage,
			Details:   details,
			BytesSent: bytesSent,
		}
	}

	// 1. M28 ---------------------------------------------------------------
	if err := setDeadline(); err != nil {
		return failErr("M28", err)
	}
	if _, err := fmt.Fprintf(conn, "M28 %s\n", filename); err != nil {
		return failErr("M28", err)
	}
	line, err := readLine(conn)
	if err != nil {
		return failErr("M28", err)
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "ok") {
		return failRejected("M28", fmt.Sprintf("printer rejected M28: %s", line))
	}

	// 2. Upload chunks -----------------------------------------------------
	offset := 0
	retryCount := 0
	for offset < totalSize {
		end := offset + defaultChunkSize
		if end > totalSize {
			end = totalSize
		}
		payload := fileData[offset:end]
		frame := BuildChunk(payload, uint32(offset))

		if err := setDeadline(); err != nil {
			return failErr("upload", err)
		}
		if _, err := conn.Write(frame); err != nil {
			return failErr("upload", err)
		}
		ackLine, err := readLine(conn)
		if err != nil {
			return failErr("upload", err)
		}
		ackLine = strings.TrimSpace(ackLine)

		if strings.HasPrefix(strings.ToLower(ackLine), "ok") {
			offset = end
			bytesSent = offset
			retryCount = 0
			continue
		}

		if strings.HasPrefix(strings.ToLower(ackLine), "resend") {
			retryCount++
			if retryCount > defaultMaxResendRetry {
				return failRejected("upload",
					fmt.Sprintf("resend retry limit exceeded (%d) after %q", defaultMaxResendRetry, ackLine))
			}
			var requested int
			if _, err := fmt.Sscanf(ackLine, "resend %d", &requested); err != nil {
				return failRejected("upload", fmt.Sprintf("malformed resend reply: %q", ackLine))
			}
			if requested < 0 || requested > totalSize {
				return failRejected("upload", fmt.Sprintf("resend out-of-range: %d", requested))
			}
			offset = requested
			bytesSent = offset
			continue
		}

		return failRejected("upload", fmt.Sprintf("unexpected reply during upload: %q", ackLine))
	}

	// 3. M29 ---------------------------------------------------------------
	if err := setDeadline(); err != nil {
		return failErr("M29", err)
	}
	if _, err := fmt.Fprintf(conn, "M29\n"); err != nil {
		return failErr("M29", err)
	}
	line, err = readLine(conn)
	if err != nil {
		return failErr("M29", err)
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "ok") {
		return failRejected("M29", fmt.Sprintf("printer rejected M29: %s", line))
	}

	// 4. M6030 (optional) --------------------------------------------------
	if startPrint {
		if err := setDeadline(); err != nil {
			return failErr("M6030", err)
		}
		if _, err := fmt.Fprintf(conn, "M6030 %s\n", filename); err != nil {
			return failErr("M6030", err)
		}
		line, err = readLine(conn)
		if err != nil {
			return failErr("M6030", err)
		}
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "ok") {
			return failRejected("M6030", fmt.Sprintf("printer rejected M6030: %s", line))
		}
	}

	return UploadResult{OK: true, BytesSent: totalSize}
}

// ---------------------------------------------------------------------------
// Error-type helpers
// ---------------------------------------------------------------------------

func isTimeout(err error) bool {
	if err == nil {
		return false
	}
	type timeouter interface{ Timeout() bool }
	if t, ok := err.(timeouter); ok {
		return t.Timeout()
	}
	return false
}

func isNetworkErr(msg string) bool {
	for _, code := range []string{
		"ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT",
		"ECONNRESET", "ENETUNREACH", "EAI_AGAIN", "EPIPE",
		"connection refused", "no such host", "host unreachable",
		"network unreachable", "broken pipe", "i/o timeout",
	} {
		if strings.Contains(strings.ToLower(msg), strings.ToLower(code)) {
			return true
		}
	}
	return false
}
