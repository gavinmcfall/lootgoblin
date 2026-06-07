package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gavinmcfall/lootgoblin/courier/internal/config"
)

// noEnv returns an empty string for any key — represents a bare environment.
func noEnv(key string) string { return "" }

// envMap returns a getenv func backed by a static map.
func envMap(m map[string]string) func(string) string {
	return func(key string) string { return m[key] }
}

// writeYAML writes content to a temp file and returns its path.
func writeYAML(t *testing.T, content string) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "courier-*.yml")
	if err != nil {
		t.Fatalf("create temp file: %v", err)
	}
	if _, err := f.WriteString(content); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close temp file: %v", err)
	}
	return f.Name()
}

func TestLoadFromPath(t *testing.T) {
	t.Run("yaml file loaded successfully", func(t *testing.T) {
		path := writeYAML(t, `
server_url: http://lootgoblin.local:7393
name: my-courier
api_key: secret-key
pair_token: abc123
heartbeat_interval_seconds: 60
claim_poll_interval_seconds: 10
default_filament_density_g_cm3: 1.30
default_filament_diameter_mm: 2.85
`)
		cfg, err := config.LoadFromPath(path, noEnv)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.ServerURL != "http://lootgoblin.local:7393" {
			t.Errorf("ServerURL = %q, want %q", cfg.ServerURL, "http://lootgoblin.local:7393")
		}
		if cfg.Name != "my-courier" {
			t.Errorf("Name = %q, want %q", cfg.Name, "my-courier")
		}
		if cfg.APIKey != "secret-key" {
			t.Errorf("APIKey = %q, want %q", cfg.APIKey, "secret-key")
		}
		if cfg.PairToken != "abc123" {
			t.Errorf("PairToken = %q, want %q", cfg.PairToken, "abc123")
		}
		if cfg.HeartbeatIntervalSeconds != 60 {
			t.Errorf("HeartbeatIntervalSeconds = %d, want 60", cfg.HeartbeatIntervalSeconds)
		}
		if cfg.ClaimPollIntervalSeconds != 10 {
			t.Errorf("ClaimPollIntervalSeconds = %d, want 10", cfg.ClaimPollIntervalSeconds)
		}
		if cfg.DefaultFilamentDensityGCm3 != 1.30 {
			t.Errorf("DefaultFilamentDensityGCm3 = %v, want 1.30", cfg.DefaultFilamentDensityGCm3)
		}
		if cfg.DefaultFilamentDiameterMm != 2.85 {
			t.Errorf("DefaultFilamentDiameterMm = %v, want 2.85", cfg.DefaultFilamentDiameterMm)
		}
	})

	t.Run("env overrides beat yaml values", func(t *testing.T) {
		path := writeYAML(t, `
server_url: http://from-yaml.local
name: yaml-name
api_key: yaml-key
pair_token: yaml-token
`)
		env := envMap(map[string]string{
			"COURIER_SERVER_URL": "http://from-env.local",
			"COURIER_NAME":       "env-name",
			"COURIER_API_KEY":    "env-key",
			"COURIER_PAIR_TOKEN": "env-token",
		})
		cfg, err := config.LoadFromPath(path, env)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.ServerURL != "http://from-env.local" {
			t.Errorf("ServerURL = %q, want %q", cfg.ServerURL, "http://from-env.local")
		}
		if cfg.Name != "env-name" {
			t.Errorf("Name = %q, want %q", cfg.Name, "env-name")
		}
		if cfg.APIKey != "env-key" {
			t.Errorf("APIKey = %q, want %q", cfg.APIKey, "env-key")
		}
		if cfg.PairToken != "env-token" {
			t.Errorf("PairToken = %q, want %q", cfg.PairToken, "env-token")
		}
	})

	t.Run("defaults applied when numeric fields not set", func(t *testing.T) {
		path := writeYAML(t, `
server_url: http://lootgoblin.local
name: defaults-test
`)
		cfg, err := config.LoadFromPath(path, noEnv)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.HeartbeatIntervalSeconds != 30 {
			t.Errorf("HeartbeatIntervalSeconds = %d, want 30", cfg.HeartbeatIntervalSeconds)
		}
		if cfg.ClaimPollIntervalSeconds != 5 {
			t.Errorf("ClaimPollIntervalSeconds = %d, want 5", cfg.ClaimPollIntervalSeconds)
		}
		if cfg.DefaultFilamentDensityGCm3 != 1.24 {
			t.Errorf("DefaultFilamentDensityGCm3 = %v, want 1.24", cfg.DefaultFilamentDensityGCm3)
		}
		if cfg.DefaultFilamentDiameterMm != 1.75 {
			t.Errorf("DefaultFilamentDiameterMm = %v, want 1.75", cfg.DefaultFilamentDiameterMm)
		}
	})

	t.Run("missing required server_url returns error", func(t *testing.T) {
		path := writeYAML(t, `name: my-courier`)
		_, err := config.LoadFromPath(path, noEnv)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		// Error must name the missing key.
		if msg := err.Error(); msg == "" {
			t.Error("error message is empty")
		}
	})

	t.Run("missing required name returns error", func(t *testing.T) {
		path := writeYAML(t, `server_url: http://lootgoblin.local`)
		_, err := config.LoadFromPath(path, noEnv)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
	})

	t.Run("both required fields missing returns error naming both", func(t *testing.T) {
		path := writeYAML(t, `heartbeat_interval_seconds: 15`)
		_, err := config.LoadFromPath(path, noEnv)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
	})

	t.Run("absent config file with full env is success", func(t *testing.T) {
		missingPath := filepath.Join(t.TempDir(), "does-not-exist.yml")
		env := envMap(map[string]string{
			"COURIER_SERVER_URL": "http://lootgoblin.local",
			"COURIER_NAME":       "env-only-courier",
		})
		cfg, err := config.LoadFromPath(missingPath, env)
		if err != nil {
			t.Fatalf("unexpected error for missing file + full env: %v", err)
		}
		if cfg.ServerURL != "http://lootgoblin.local" {
			t.Errorf("ServerURL = %q, want %q", cfg.ServerURL, "http://lootgoblin.local")
		}
		if cfg.Name != "env-only-courier" {
			t.Errorf("Name = %q, want %q", cfg.Name, "env-only-courier")
		}
		// Defaults must still be applied.
		if cfg.HeartbeatIntervalSeconds != 30 {
			t.Errorf("HeartbeatIntervalSeconds = %d, want 30", cfg.HeartbeatIntervalSeconds)
		}
	})

	t.Run("malformed YAML returns error", func(t *testing.T) {
		path := writeYAML(t, `
server_url: [unclosed bracket
name: broken
`)
		_, err := config.LoadFromPath(path, noEnv)
		if err == nil {
			t.Fatal("expected error for malformed YAML, got nil")
		}
	})
}
