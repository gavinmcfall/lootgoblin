package octoprint

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

const (
	// DefaultTimeoutSeconds is the upload timeout applied when no custom http.Client
	// is provided, matching the Node adapter's 60 000 ms constant.
	DefaultTimeoutSeconds = 60
)

// octoprintUploadResponse is the JSON shape returned by a successful OctoPrint
// file-upload (POST /api/files/local).
type octoprintUploadResponse struct {
	Files struct {
		Local struct {
			Path string `json:"path"`
		} `json:"local"`
	} `json:"files"`
}

// Dispatch uploads the gcode file at artifactPath to the OctoPrint instance
// described by cfg, using cred for authentication (may be nil).
//
// hc is the http.Client to use; pass nil to use a default client with a 60-second
// timeout.
//
// The function faithfully mirrors the Node adapter's wire behaviour:
//   - requiresAuth=true + nil/no-key cred → no-credentials, no network call
//   - POST multipart to {scheme}://{host}:{port}{apiPath}/files/local
//   - Multipart fields: file (gcode bytes, using basename), select, print
//   - X-Api-Key header when an API key is present
//   - 200/201 → OK; remoteFilename from files.local.path or basename fallback
//   - 401/403 → auth-failed; other 4xx → rejected; 5xx → unknown
//   - context deadline / timeout → timeout; dial/network error → unreachable
func Dispatch(ctx context.Context, cfg ConnectionConfig, cred *Credential, artifactPath string, hc *http.Client, log *slog.Logger) printers.DispatchOutcome {
	if log == nil {
		log = slog.Default()
	}

	// No-credentials guard: if auth is required but we have nothing to send,
	// return immediately without touching the network.
	if cfg.RequiresAuth && (cred == nil || cred.APIKey == "") {
		return printers.DispatchOutcome{Reason: "no-credentials"}
	}

	// Read the artifact file.
	fileBytes, err := os.ReadFile(artifactPath)
	if err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: fmt.Sprintf("failed to read artifact: %s", err.Error()),
		}
	}

	filename := filepath.Base(artifactPath)

	// Build multipart body.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	// Field: file
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: fmt.Sprintf("failed to create multipart file field: %s", err.Error()),
		}
	}
	if _, err := io.Copy(fw, bytes.NewReader(fileBytes)); err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: fmt.Sprintf("failed to write file bytes to multipart: %s", err.Error()),
		}
	}

	// Fields: select, print
	selectVal := "false"
	if cfg.Select {
		selectVal = "true"
	}
	_ = mw.WriteField("select", selectVal)

	printVal := "false"
	if cfg.StartPrint {
		printVal = "true"
	}
	_ = mw.WriteField("print", printVal)

	if err := mw.Close(); err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: fmt.Sprintf("failed to finalise multipart body: %s", err.Error()),
		}
	}

	contentType := mw.FormDataContentType()

	// Build URL: {scheme}://{host}:{port}{apiPath}/files/local
	uploadURL := fmt.Sprintf("%s://%s:%d%s/files/local", cfg.Scheme, cfg.Host, cfg.Port, cfg.APIPath)

	// Build HTTP request.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, &buf)
	if err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: fmt.Sprintf("failed to build request: %s", err.Error()),
		}
	}
	req.Header.Set("Content-Type", contentType)

	// Attach API key when present.
	if cred != nil && cred.APIKey != "" {
		req.Header.Set("X-Api-Key", cred.APIKey)
	}

	// Use injected client or construct a default one.
	client := hc
	if client == nil {
		client = &http.Client{Timeout: DefaultTimeoutSeconds * time.Second}
	}

	// Execute.
	resp, err := client.Do(req)
	if err != nil {
		return mapRequestError(err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	status := resp.StatusCode

	if status == http.StatusOK || status == http.StatusCreated {
		remoteFilename := filename
		var parsed octoprintUploadResponse
		if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
			if p := parsed.Files.Local.Path; p != "" {
				remoteFilename = p
			}
		}
		log.Info("octoprint: dispatch succeeded",
			"remoteFilename", remoteFilename,
			"artifactPath", artifactPath,
		)
		return printers.DispatchOutcome{OK: true, RemoteFilename: remoteFilename}
	}

	details := excerpt(string(bodyBytes))

	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		log.Warn("octoprint: auth rejected by printer", "status", status)
		return printers.DispatchOutcome{Reason: "auth-failed", Details: details}
	}
	if status >= 400 && status < 500 {
		log.Warn("octoprint: printer rejected upload", "status", status)
		return printers.DispatchOutcome{Reason: "rejected", Details: details}
	}
	// 5xx and anything else.
	log.Warn("octoprint: printer returned server error", "status", status)
	return printers.DispatchOutcome{Reason: "unknown", Details: details}
}

// mapRequestError converts a Do-level error into a DispatchOutcome with the
// appropriate reason code, matching the Node adapter's failure mapping:
//   - context deadline exceeded (timeout) → timeout
//   - dial/connection errors → unreachable
//   - anything else → unknown
func mapRequestError(err error) printers.DispatchOutcome {
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

// isNetDialError returns true for low-level connection/dial failures.
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

func excerpt(s string) string {
	if len(s) > bodyExcerptMax {
		return s[:bodyExcerptMax]
	}
	return s
}
