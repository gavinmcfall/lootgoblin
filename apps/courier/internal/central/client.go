package central

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Sentinel errors
// ---------------------------------------------------------------------------

// ErrUnauthorized is returned when the server responds with 401.
var ErrUnauthorized = errors.New("central: unauthorized — invalid or missing API key")

// ErrForbidden is returned when the server responds with 403.
var ErrForbidden = errors.New("central: forbidden")

// ErrArtifactNotFound is returned when the artifact endpoint responds with 404.
var ErrArtifactNotFound = errors.New("central: artifact not found")

// ErrPairTokenUsed is returned when the pair endpoint responds with 409
// pair-token-already-used.
var ErrPairTokenUsed = errors.New("central: pair token already used")

// ---------------------------------------------------------------------------
// Typed errors (carry extra context, errors.Is-compatible)
// ---------------------------------------------------------------------------

// PairTokenError is returned when the pair endpoint responds with 400
// invalid-pair-token.  Reason carries the server's reason string
// ('invalid-or-expired' or 'wrong-kind').
type PairTokenError struct {
	Reason string
}

func (e *PairTokenError) Error() string {
	return fmt.Sprintf("central: invalid pair token — %s", e.Reason)
}

// ErrInvalidPairToken is the target for errors.Is matching against
// *PairTokenError values.
var ErrInvalidPairToken = errors.New("central: invalid pair token")

func (e *PairTokenError) Is(target error) bool {
	return target == ErrInvalidPairToken
}

// VersionIncompatibleError is returned when the heartbeat endpoint responds
// with 409 version-incompatible.
type VersionIncompatibleError struct {
	ServerVersion string
	Action        string
}

func (e *VersionIncompatibleError) Error() string {
	return fmt.Sprintf("central: version incompatible — server %s, action: %s", e.ServerVersion, e.Action)
}

// ErrVersionIncompatible is the target for errors.Is matching against
// *VersionIncompatibleError values.
var ErrVersionIncompatible = errors.New("central: version incompatible")

func (e *VersionIncompatibleError) Is(target error) bool {
	return target == ErrVersionIncompatible
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// Client is a typed HTTP client for the lootgoblin central instance API.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	version    string
}

// New returns a new Client.  If hc is nil a default client with a 30s timeout
// is used.  baseURL may have a trailing slash — it is normalised internally.
func New(baseURL, apiKey, version string, hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
		httpClient: hc,
		version:    version,
	}
}

// url builds the full request URL by joining the normalised base with path.
// path must begin with '/' (ensured by callers).
func (c *Client) url(path string) string {
	return c.baseURL + "/" + strings.TrimLeft(path, "/")
}

// doJSON sends a request and decodes the response body into dst (if non-nil).
// It also returns the raw *http.Response so callers can inspect headers/status.
func (c *Client) doJSON(ctx context.Context, method, path string, withAuth bool, body interface{}, dst interface{}) (*http.Response, error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("central: marshal request body: %w", err)
		}
		reqBody = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.url(path), reqBody)
	if err != nil {
		return nil, fmt.Errorf("central: build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if withAuth {
		req.Header.Set("x-api-key", c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("central: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp, fmt.Errorf("central: read response body: %w", err)
	}

	if dst != nil && len(rawBody) > 0 {
		if err := json.Unmarshal(rawBody, dst); err != nil {
			return resp, fmt.Errorf("central: decode response (status %d): %w", resp.StatusCode, err)
		}
	}

	// Attach a no-op closer so callers can safely re-read if needed.
	resp.Body = io.NopCloser(bytes.NewReader(rawBody))

	return resp, nil
}

// snippetOf returns the first n bytes of b as a string for error messages.
func snippetOf(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}

// readBody fully reads resp.Body (which has been replaced by a NopCloser after
// doJSON) back into a byte slice for error context.
func readBody(resp *http.Response) []byte {
	if resp.Body == nil {
		return nil
	}
	b, _ := io.ReadAll(resp.Body)
	return b
}

// ---------------------------------------------------------------------------
// GetInstance
// ---------------------------------------------------------------------------

// GetInstance calls GET /api/v1/instance (no auth) and returns the instance's
// public identity triple.
func (c *Client) GetInstance(ctx context.Context) (*Instance, error) {
	var out Instance
	resp, err := c.doJSON(ctx, http.MethodGet, "/api/v1/instance", false, nil, &out)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("central: GetInstance: unexpected status %d: %s",
			resp.StatusCode, snippetOf(readBody(resp), 256))
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// Pair
// ---------------------------------------------------------------------------

// pairBody is the request body for the pair endpoint.
type pairBody struct {
	Token            string  `json:"token"`
	Name             string  `json:"name,omitempty"`
	ReachableLANHint *string `json:"reachable_lan_hint"`
}

// pairErrorBody is the error shape from the pair endpoint.
type pairErrorBody struct {
	Error  string `json:"error"`
	Reason string `json:"reason"`
}

// Pair calls POST /api/v1/couriers/pair (no auth) and exchanges a one-time
// pair token for a long-lived API key.
//
// Mapped errors:
//   - 400 invalid-pair-token → *PairTokenError (errors.Is(err, ErrInvalidPairToken))
//   - 409 pair-token-already-used → ErrPairTokenUsed
func (c *Client) Pair(ctx context.Context, token, name, reachableLANHint string) (*PairResult, error) {
	var hint *string
	if reachableLANHint != "" {
		hint = &reachableLANHint
	}

	body := pairBody{
		Token:            token,
		Name:             name,
		ReachableLANHint: hint,
	}

	var out PairResult
	var errOut pairErrorBody

	// We need to inspect the status code before deciding which struct to use,
	// so decode into the success struct and re-decode for error cases.
	resp, err := c.doJSON(ctx, http.MethodPost, "/api/v1/couriers/pair", false, body, nil)
	if err != nil {
		return nil, err
	}

	rawBody := readBody(resp)

	switch resp.StatusCode {
	case http.StatusOK:
		if err := json.Unmarshal(rawBody, &out); err != nil {
			return nil, fmt.Errorf("central: Pair: decode success response: %w", err)
		}
		return &out, nil

	case http.StatusBadRequest:
		if err := json.Unmarshal(rawBody, &errOut); err != nil {
			return nil, fmt.Errorf("central: Pair: decode 400 response: %w", err)
		}
		if errOut.Error == "invalid-pair-token" {
			return nil, &PairTokenError{Reason: errOut.Reason}
		}
		return nil, fmt.Errorf("central: Pair: 400 %s: %s", errOut.Error, errOut.Reason)

	case http.StatusConflict:
		_ = json.Unmarshal(rawBody, &errOut)
		if errOut.Error == "pair-token-already-used" {
			return nil, ErrPairTokenUsed
		}
		return nil, fmt.Errorf("central: Pair: 409 %s", snippetOf(rawBody, 256))

	default:
		return nil, fmt.Errorf("central: Pair: unexpected status %d: %s",
			resp.StatusCode, snippetOf(rawBody, 256))
	}
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

// heartbeatErrorBody is the error shape from the heartbeat endpoint.
type heartbeatErrorBody struct {
	Error         string `json:"error"`
	ServerVersion string `json:"server_version"`
	Action        string `json:"action"`
}

// Heartbeat calls POST /api/v1/couriers/heartbeat (x-api-key auth).
//
// Mapped errors:
//   - 409 version-incompatible → *VersionIncompatibleError
func (c *Client) Heartbeat(ctx context.Context, req HeartbeatRequest) (*HeartbeatResult, error) {
	resp, err := c.doJSON(ctx, http.MethodPost, "/api/v1/couriers/heartbeat", true, req, nil)
	if err != nil {
		return nil, err
	}

	rawBody := readBody(resp)

	switch resp.StatusCode {
	case http.StatusOK:
		var out HeartbeatResult
		if err := json.Unmarshal(rawBody, &out); err != nil {
			return nil, fmt.Errorf("central: Heartbeat: decode response: %w", err)
		}
		return &out, nil

	case http.StatusConflict:
		var errOut heartbeatErrorBody
		_ = json.Unmarshal(rawBody, &errOut)
		if errOut.Error == "version-incompatible" {
			return nil, &VersionIncompatibleError{
				ServerVersion: errOut.ServerVersion,
				Action:        errOut.Action,
			}
		}
		return nil, fmt.Errorf("central: Heartbeat: 409 %s", snippetOf(rawBody, 256))

	case http.StatusUnauthorized:
		return nil, ErrUnauthorized

	default:
		return nil, fmt.Errorf("central: Heartbeat: unexpected status %d: %s",
			resp.StatusCode, snippetOf(rawBody, 256))
	}
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

// claimResponse is the raw response from the claim endpoint; job may be null.
type claimResponse struct {
	Job        *claimJobRaw        `json:"job"`
	Printer    *ClaimPrinter       `json:"printer"`
	Credential *ClaimCredential    `json:"credential"`
	Artifact   *ClaimArtifact      `json:"artifact"`
}

// claimJobRaw mirrors ClaimJob but is used only for JSON decoding inside
// claimResponse so we can detect the job:null case.
type claimJobRaw struct {
	ID         string `json:"id"`
	TargetKind string `json:"target_kind"`
	TargetID   string `json:"target_id"`
	LootID     string `json:"loot_id"`
	OwnerID    string `json:"owner_id"`
}

// claimUnauthorizedBody is the 401 error shape.
type claimUnauthorizedBody struct {
	Error string `json:"error"`
}

// Claim calls POST /api/v1/dispatch/claim (x-api-key auth).
//
// Returns (nil, nil) when the server responds { "job": null } — meaning no job
// is currently available; this is NOT an error.
//
// Mapped errors:
//   - 401 → ErrUnauthorized
func (c *Client) Claim(ctx context.Context) (*ClaimBundle, error) {
	resp, err := c.doJSON(ctx, http.MethodPost, "/api/v1/dispatch/claim", true, struct{}{}, nil)
	if err != nil {
		return nil, err
	}

	rawBody := readBody(resp)

	switch resp.StatusCode {
	case http.StatusOK:
		var out claimResponse
		if err := json.Unmarshal(rawBody, &out); err != nil {
			return nil, fmt.Errorf("central: Claim: decode response: %w", err)
		}
		if out.Job == nil {
			// { "job": null } — no available job, not an error.
			return nil, nil
		}
		return &ClaimBundle{
			Job: ClaimJob{
				ID:         out.Job.ID,
				TargetKind: out.Job.TargetKind,
				TargetID:   out.Job.TargetID,
				LootID:     out.Job.LootID,
				OwnerID:    out.Job.OwnerID,
			},
			Printer:    out.Printer,
			Credential: out.Credential,
			Artifact:   out.Artifact,
		}, nil

	case http.StatusUnauthorized:
		return nil, ErrUnauthorized

	default:
		return nil, fmt.Errorf("central: Claim: unexpected status %d: %s",
			resp.StatusCode, snippetOf(rawBody, 256))
	}
}

// ---------------------------------------------------------------------------
// DownloadArtifact
// ---------------------------------------------------------------------------

// DownloadArtifact calls GET /api/v1/dispatch/artifact/<jobID> (x-api-key auth)
// and streams the file bytes into w.  It returns the X-Artifact-SHA256 response
// header value for the caller to verify integrity.
//
// Mapped errors:
//   - 403 → ErrForbidden
//   - 404 → ErrArtifactNotFound
func (c *Client) DownloadArtifact(ctx context.Context, jobID string, w io.Writer) (sha256Header string, err error) {
	reqURL := c.url("/api/v1/dispatch/artifact/" + jobID)

	req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if reqErr != nil {
		return "", fmt.Errorf("central: DownloadArtifact: build request: %w", reqErr)
	}
	req.Header.Set("x-api-key", c.apiKey)

	resp, doErr := c.httpClient.Do(req)
	if doErr != nil {
		return "", fmt.Errorf("central: DownloadArtifact: %w", doErr)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		sha256Header = resp.Header.Get("X-Artifact-SHA256")
		if _, copyErr := io.Copy(w, resp.Body); copyErr != nil {
			return sha256Header, fmt.Errorf("central: DownloadArtifact: stream bytes: %w", copyErr)
		}
		return sha256Header, nil

	case http.StatusForbidden:
		return "", ErrForbidden

	case http.StatusNotFound:
		return "", ErrArtifactNotFound

	default:
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return "", fmt.Errorf("central: DownloadArtifact: unexpected status %d: %s",
			resp.StatusCode, snippetOf(snippet, 256))
	}
}

// ---------------------------------------------------------------------------
// ReportStatus
// ---------------------------------------------------------------------------

// statusOKBody is the success shape from the status endpoint.
type statusOKBody struct {
	OK   bool `json:"ok"`
	Noop bool `json:"noop"`
}

// ReportStatus calls POST /api/v1/dispatch/status (x-api-key auth).
// Both { ok: true } and { ok: true, noop: true } are treated as success.
func (c *Client) ReportStatus(ctx context.Context, payload StatusReport) error {
	resp, err := c.doJSON(ctx, http.MethodPost, "/api/v1/dispatch/status", true, payload, nil)
	if err != nil {
		return err
	}

	rawBody := readBody(resp)

	switch resp.StatusCode {
	case http.StatusOK:
		var out statusOKBody
		_ = json.Unmarshal(rawBody, &out)
		if out.OK {
			return nil
		}
		return fmt.Errorf("central: ReportStatus: server returned ok=false: %s", snippetOf(rawBody, 256))

	case http.StatusUnauthorized:
		return ErrUnauthorized

	case http.StatusForbidden:
		return ErrForbidden

	default:
		return fmt.Errorf("central: ReportStatus: unexpected status %d: %s",
			resp.StatusCode, snippetOf(rawBody, 256))
	}
}
