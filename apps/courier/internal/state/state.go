// Package state manages the small persisted-state file that the courier writes
// after a successful pairing handshake.  The file stores the long-lived API
// key, agent ID, and instance ID as JSON with 0600 permissions so other OS
// users cannot read the credentials.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// State is the data persisted to disk after a successful pairing handshake.
type State struct {
	APIKey     string `json:"api_key"`
	AgentID    string `json:"agent_id"`
	InstanceID string `json:"instance_id"`
}

// Save writes s to path as JSON with 0600 file permissions.  Any missing
// parent directories are created with 0700 permissions.  Callers should supply
// an absolute path so the file ends up in a predictable location.
func Save(path string, s State) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("state: create parent dir %q: %w", dir, err)
	}

	data, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("state: marshal state: %w", err)
	}

	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("state: write %q: %w", path, err)
	}

	return nil
}

// Load reads and decodes the state file at path.  If the file does not exist,
// Load returns a zero State and a nil error — absence is not an error.
func Load(path string) (State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return State{}, nil
		}
		return State{}, fmt.Errorf("state: read %q: %w", path, err)
	}

	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return State{}, fmt.Errorf("state: decode %q: %w", path, err)
	}

	return s, nil
}
