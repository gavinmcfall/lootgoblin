package state_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gavinmcfall/lootgoblin/courier/internal/state"
)

func TestSaveAndLoad_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	want := state.State{
		APIKey:     "ak-test-1234",
		AgentID:    "agent-abc",
		InstanceID: "inst-xyz",
	}

	if err := state.Save(path, want); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := state.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got != want {
		t.Errorf("round-trip mismatch: got %+v, want %+v", got, want)
	}
}

func TestSave_FilePermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	if err := state.Save(path, state.State{APIKey: "k"}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}

	if got := info.Mode().Perm(); got != 0o600 {
		t.Errorf("file permissions: got %04o, want 0600", got)
	}
}

func TestSave_CreatesParentDir(t *testing.T) {
	dir := t.TempDir()
	// Nested directories that do not exist yet.
	path := filepath.Join(dir, "sub", "dir", "state.json")

	if err := state.Save(path, state.State{AgentID: "a"}); err != nil {
		t.Fatalf("Save with nested path: %v", err)
	}

	if _, err := os.Stat(path); err != nil {
		t.Errorf("expected file to exist: %v", err)
	}
}

func TestLoad_AbsentFile_ReturnsZeroNoError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "does-not-exist.json")

	got, err := state.Load(path)
	if err != nil {
		t.Fatalf("Load absent file: expected nil error, got %v", err)
	}
	if got != (state.State{}) {
		t.Errorf("expected zero State for absent file, got %+v", got)
	}
}

func TestLoad_CorruptJSON_ReturnsError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	if err := os.WriteFile(path, []byte("{not valid json"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, err := state.Load(path); err == nil {
		t.Error("Load corrupt JSON: expected error, got nil")
	}
}
