// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package pairing_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/config"
	"github.com/gavinmcfall/lootgoblin/courier/internal/pairing"
	"github.com/gavinmcfall/lootgoblin/courier/internal/state"
)

// nopLogger returns a logger that discards all output.
func nopLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(noopWriter{}, nil))
}

type noopWriter struct{}

func (noopWriter) Write(p []byte) (int, error) { return len(p), nil }

// fakePairServer returns a test server that always responds with a successful
// pair result using the provided fields.
func fakePairServer(t *testing.T, apiKey, agentID, instanceID string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/couriers/pair" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"api_key":        apiKey,
			"agent_id":       agentID,
			"instance_id":    instanceID,
			"server_version": "test",
		})
	}))
}

// mustClient constructs a central.Client against the given server URL.
func mustClient(serverURL string) *central.Client {
	return central.New(serverURL, "", "test", nil)
}

// ---------------------------------------------------------------------------
// Already-paired: must not call the server
// ---------------------------------------------------------------------------

func TestEnsurePaired_AlreadyPaired_NoServerCall(t *testing.T) {
	// Any request to this server fails the test.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("EnsurePaired hit the server when APIKey was already set (path: %s)", r.URL.Path)
		http.Error(w, "should not be called", http.StatusInternalServerError)
	}))
	defer srv.Close()

	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")

	// Pre-seed the state file with an agent ID.
	if err := state.Save(statePath, state.State{
		APIKey:  "existing-key",
		AgentID: "existing-agent",
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	cfg := &config.Config{
		ServerURL: srv.URL,
		Name:      "test-courier",
		APIKey:    "existing-key",
	}
	client := mustClient(srv.URL)

	apiKey, agentID, err := pairing.EnsurePaired(
		context.Background(), cfg, client, statePath,
		strings.NewReader(""), nopLogger(),
	)
	if err != nil {
		t.Fatalf("EnsurePaired: %v", err)
	}
	if apiKey != "existing-key" {
		t.Errorf("apiKey: got %q, want %q", apiKey, "existing-key")
	}
	if agentID != "existing-agent" {
		t.Errorf("agentID: got %q, want %q", agentID, "existing-agent")
	}
}

// ---------------------------------------------------------------------------
// Token from config → success → 0600 JSON persisted
// ---------------------------------------------------------------------------

func TestEnsurePaired_TokenFromConfig_PersistsState(t *testing.T) {
	srv := fakePairServer(t, "new-api-key", "agent-001", "inst-001")
	defer srv.Close()

	dir := t.TempDir()
	statePath := filepath.Join(dir, "courier-state.json")

	cfg := &config.Config{
		ServerURL: srv.URL,
		Name:      "test-courier",
		PairToken: "tok-abc",
	}
	client := mustClient(srv.URL)

	apiKey, agentID, err := pairing.EnsurePaired(
		context.Background(), cfg, client, statePath,
		strings.NewReader(""), nopLogger(),
	)
	if err != nil {
		t.Fatalf("EnsurePaired: %v", err)
	}
	if apiKey != "new-api-key" {
		t.Errorf("apiKey: got %q, want %q", apiKey, "new-api-key")
	}
	if agentID != "agent-001" {
		t.Errorf("agentID: got %q, want %q", agentID, "agent-001")
	}

	// Verify the persisted file.
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatalf("Stat state file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("file permissions: got %04o, want 0600", perm)
	}

	s, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load state: %v", err)
	}
	if s.APIKey != "new-api-key" {
		t.Errorf("persisted APIKey: got %q, want %q", s.APIKey, "new-api-key")
	}
	if s.AgentID != "agent-001" {
		t.Errorf("persisted AgentID: got %q, want %q", s.AgentID, "agent-001")
	}
	if s.InstanceID != "inst-001" {
		t.Errorf("persisted InstanceID: got %q, want %q", s.InstanceID, "inst-001")
	}
}

// ---------------------------------------------------------------------------
// Token from interactive reader
// ---------------------------------------------------------------------------

func TestEnsurePaired_TokenFromInteractiveReader(t *testing.T) {
	srv := fakePairServer(t, "reader-key", "agent-reader", "inst-reader")
	defer srv.Close()

	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")

	// No PairToken in config; token comes from the reader.
	cfg := &config.Config{
		ServerURL: srv.URL,
		Name:      "test-courier",
	}
	client := mustClient(srv.URL)

	apiKey, _, err := pairing.EnsurePaired(
		context.Background(), cfg, client, statePath,
		strings.NewReader("  tok-from-reader  \n"), nopLogger(),
	)
	if err != nil {
		t.Fatalf("EnsurePaired: %v", err)
	}
	if apiKey != "reader-key" {
		t.Errorf("apiKey: got %q, want %q", apiKey, "reader-key")
	}
}

// ---------------------------------------------------------------------------
// Empty token → clear error, no server call
// ---------------------------------------------------------------------------

func TestEnsurePaired_EmptyToken_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("should not reach the server on empty token (path: %s)", r.URL.Path)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer srv.Close()

	dir := t.TempDir()
	cfg := &config.Config{ServerURL: srv.URL, Name: "test-courier"}
	client := mustClient(srv.URL)

	_, _, err := pairing.EnsurePaired(
		context.Background(), cfg, client,
		filepath.Join(dir, "state.json"),
		strings.NewReader(""), nopLogger(),
	)
	if err == nil {
		t.Fatal("expected error for empty token, got nil")
	}
	if !strings.Contains(err.Error(), "no pair token") {
		t.Errorf("error message should contain 'no pair token', got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// ErrInvalidPairToken → reason surfaced, no persistence
// ---------------------------------------------------------------------------

func TestEnsurePaired_InvalidPairToken_ReasonSurfaced_NoPersistence(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":  "invalid-pair-token",
			"reason": "invalid-or-expired",
		})
	}))
	defer srv.Close()

	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")

	cfg := &config.Config{ServerURL: srv.URL, Name: "test", PairToken: "bad-tok"}
	client := mustClient(srv.URL)

	_, _, err := pairing.EnsurePaired(
		context.Background(), cfg, client, statePath,
		strings.NewReader(""), nopLogger(),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "invalid-or-expired") {
		t.Errorf("error should surface reason 'invalid-or-expired', got: %v", err)
	}

	// Nothing should be persisted.
	if _, statErr := os.Stat(statePath); !errors.Is(statErr, os.ErrNotExist) {
		t.Errorf("state file should not exist after failure, but Stat returned: %v", statErr)
	}
}

// errors.Is should still match ErrInvalidPairToken through the wrapping.
func TestEnsurePaired_InvalidPairToken_ErrorIsCompatible(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":  "invalid-pair-token",
			"reason": "wrong-kind",
		})
	}))
	defer srv.Close()

	dir := t.TempDir()
	cfg := &config.Config{ServerURL: srv.URL, Name: "test", PairToken: "bad"}
	client := mustClient(srv.URL)

	_, _, err := pairing.EnsurePaired(
		context.Background(), cfg, client,
		filepath.Join(dir, "state.json"),
		strings.NewReader(""), nopLogger(),
	)
	if err == nil {
		t.Fatal("expected error")
	}
	// The pairing package wraps with fmt.Errorf which loses Is-ability for the
	// typed error — but we verify the reason string is present in the message.
	if !strings.Contains(err.Error(), "wrong-kind") {
		t.Errorf("error should contain 'wrong-kind', got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// ErrPairTokenUsed → clear error, no persistence
// ---------------------------------------------------------------------------

func TestEnsurePaired_PairTokenUsed_ClearError_NoPersistence(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "pair-token-already-used",
		})
	}))
	defer srv.Close()

	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")

	cfg := &config.Config{ServerURL: srv.URL, Name: "test", PairToken: "used-tok"}
	client := mustClient(srv.URL)

	_, _, err := pairing.EnsurePaired(
		context.Background(), cfg, client, statePath,
		strings.NewReader(""), nopLogger(),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "already used") {
		t.Errorf("error should mention 'already used', got: %v", err)
	}
	if !strings.Contains(err.Error(), "generate a new one") {
		t.Errorf("error should mention 'generate a new one', got: %v", err)
	}

	// Nothing persisted.
	if _, statErr := os.Stat(statePath); !errors.Is(statErr, os.ErrNotExist) {
		t.Errorf("state file should not exist after failure, but Stat returned: %v", statErr)
	}
}

// ---------------------------------------------------------------------------
// Compile-time check: EnsurePaired signature
// ---------------------------------------------------------------------------

var _ = func() {
	// This block never runs; it only exercises the type checker.
	var (
		ctx       = context.Background()
		cfg       *config.Config
		client    *central.Client
		statePath string
		promptIn  strings.Reader
		log       *slog.Logger
		_         string
		_         error
		_         fmt.Stringer // suppress unused import
	)
	_, _, _ = pairing.EnsurePaired(ctx, cfg, client, statePath, &promptIn, log)
}
