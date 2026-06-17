// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package sdcp

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// defaultChunkSize is 1 MiB, matching the SDCP 3.0 spec and the Node uploader.
const defaultChunkSize = 1 << 20 // 1 048 576

// defaultChunkTimeoutSeconds is the per-chunk POST timeout (30 s).
const defaultChunkTimeoutSeconds = 30

// UploadResult is the result of uploadFileChunked.
type UploadResult struct {
	OK        bool
	UUID      string
	MD5Hex    string
	BytesSent int
	Reason    string // unreachable|rejected|timeout|unknown (no auth-failed — no auth in SDCP)
	Details   string
}

// uploadFileChunked uploads data to the SDCP printer at
// POST http://{ip}:{port}/uploadFile/upload in 1-MiB chunks.
//
// Per-chunk multipart fields (matching Node uploader exactly):
//
//	S-File-MD5  — MD5 hex of the FULL file, constant across all chunks
//	Check       — "1" on first chunk, "0" thereafter
//	Offset      — byte offset of this chunk
//	Uuid        — session UUID, constant across all chunks
//	TotalSize   — total file size in bytes, constant
//	File        — the chunk bytes
//
// hc is injectable for tests; pass nil for the default client.
func uploadFileChunked(
	ctx context.Context,
	cfg ConnectionConfig,
	data []byte,
	filename string,
	sessionUUID string,
	hc *http.Client,
	log *slog.Logger,
) UploadResult {
	if log == nil {
		log = slog.Default()
	}

	// Compute full-file MD5 once (constant across all chunks).
	sum := md5.Sum(data)
	md5Hex := hex.EncodeToString(sum[:])

	totalSize := len(data)
	uploadURL := fmt.Sprintf("http://%s:%d/uploadFile/upload", cfg.IP, cfg.Port)

	client := hc
	if client == nil {
		client = &http.Client{Timeout: defaultChunkTimeoutSeconds * time.Second}
	}

	bytesSent := 0
	chunkIndex := 0

	for bytesSent < totalSize {
		end := bytesSent + defaultChunkSize
		if end > totalSize {
			end = totalSize
		}
		chunk := data[bytesSent:end]
		isFirst := chunkIndex == 0

		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)

		_ = mw.WriteField("S-File-MD5", md5Hex)
		checkVal := "0"
		if isFirst {
			checkVal = "1"
		}
		_ = mw.WriteField("Check", checkVal)
		_ = mw.WriteField("Offset", strconv.Itoa(bytesSent))
		_ = mw.WriteField("Uuid", sessionUUID)
		_ = mw.WriteField("TotalSize", strconv.Itoa(totalSize))

		fw, err := mw.CreateFormFile("File", filename)
		if err != nil {
			return UploadResult{
				Reason:    "unknown",
				Details:   fmt.Sprintf("create multipart file field: %s", err.Error()),
				BytesSent: bytesSent,
				UUID:      sessionUUID,
			}
		}
		if _, err := io.Copy(fw, bytes.NewReader(chunk)); err != nil {
			return UploadResult{
				Reason:    "unknown",
				Details:   fmt.Sprintf("write chunk bytes: %s", err.Error()),
				BytesSent: bytesSent,
				UUID:      sessionUUID,
			}
		}
		if err := mw.Close(); err != nil {
			return UploadResult{
				Reason:    "unknown",
				Details:   fmt.Sprintf("finalise multipart: %s", err.Error()),
				BytesSent: bytesSent,
				UUID:      sessionUUID,
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, &buf)
		if err != nil {
			return UploadResult{
				Reason:    "unknown",
				Details:   fmt.Sprintf("build request: %s", err.Error()),
				BytesSent: bytesSent,
				UUID:      sessionUUID,
			}
		}
		req.Header.Set("Content-Type", mw.FormDataContentType())

		resp, err := client.Do(req)
		if err != nil {
			outcome := mapHTTPError(err)
			log.Warn("sdcp-uploader: chunk POST threw",
				"ip", cfg.IP, "port", cfg.Port,
				"uuid", sessionUUID, "md5", md5Hex,
				"chunkIndex", chunkIndex, "bytesSent", bytesSent,
				"reason", outcome.Reason,
			)
			return UploadResult{
				Reason:    outcome.Reason,
				Details:   outcome.Details,
				BytesSent: bytesSent,
				UUID:      sessionUUID,
			}
		}
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()

		if !isHTTPSuccess(resp.StatusCode) {
			reason := mapHTTPStatus(resp.StatusCode)
			details := fmt.Sprintf("HTTP %d %s: %s", resp.StatusCode, resp.Status, excerptBytes(bodyBytes))
			log.Warn("sdcp-uploader: chunk rejected",
				"ip", cfg.IP, "port", cfg.Port,
				"uuid", sessionUUID, "md5", md5Hex,
				"chunkIndex", chunkIndex, "status", resp.StatusCode,
				"reason", reason,
			)
			return UploadResult{
				Reason:    reason,
				Details:   details,
				BytesSent: bytesSent,
				UUID:      sessionUUID,
			}
		}

		bytesSent += len(chunk)
		chunkIndex++
	}

	return UploadResult{
		OK:        true,
		UUID:      sessionUUID,
		MD5Hex:    md5Hex,
		BytesSent: bytesSent,
	}
}

// ---------------------------------------------------------------------------
// Error mapping helpers
// ---------------------------------------------------------------------------

func isHTTPSuccess(status int) bool {
	return status == http.StatusOK || status == http.StatusCreated
}

// mapHTTPStatus maps an HTTP status code to a dispatch reason.
// SDCP has no auth, but we map 401/403 as 'rejected' (spec reserved).
func mapHTTPStatus(status int) string {
	if status >= 400 && status < 500 {
		return "rejected"
	}
	return "unknown"
}

// mapHTTPError converts a Do-level error into a reason + details.
func mapHTTPError(err error) printers.DispatchOutcome {
	if errors.Is(err, context.DeadlineExceeded) {
		return printers.DispatchOutcome{Reason: "timeout", Details: err.Error()}
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		if urlErr.Timeout() {
			return printers.DispatchOutcome{Reason: "timeout", Details: err.Error()}
		}
		if isNetDialError(urlErr.Err) {
			return printers.DispatchOutcome{Reason: "unreachable", Details: err.Error()}
		}
		if errors.Is(urlErr.Err, context.DeadlineExceeded) {
			return printers.DispatchOutcome{Reason: "timeout", Details: err.Error()}
		}
	}
	if isNetDialError(err) {
		return printers.DispatchOutcome{Reason: "unreachable", Details: err.Error()}
	}
	return printers.DispatchOutcome{Reason: "unknown", Details: err.Error()}
}

func isNetDialError(err error) bool {
	if err == nil {
		return false
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return true
	}
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr)
}

const bodyExcerptMax = 500

func excerptBytes(b []byte) string {
	s := string(b)
	if len(s) > bodyExcerptMax {
		return s[:bodyExcerptMax]
	}
	return s
}
