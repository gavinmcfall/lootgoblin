// Package config handles loading and validating courier configuration from
// a YAML file and environment variable overrides.
package config

import (
	"errors"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

const (
	defaultConfigPath              = "/config/courier.yml"
	defaultHeartbeatIntervalSecs   = 30
	defaultClaimPollIntervalSecs   = 5
	defaultFilamentDensityGCm3     = 1.24
	defaultFilamentDiameterMm      = 1.75
)

// Config holds all runtime configuration for the courier agent.
// Fields are populated from a YAML file and then overridden by environment
// variables where applicable.
type Config struct {
	// ServerURL is the base URL of the central lootgoblin instance. REQUIRED.
	ServerURL string `yaml:"server_url"`

	// Name is the human-readable name for this courier agent. REQUIRED.
	Name string `yaml:"name"`

	// APIKey is the API key used after the pairing flow completes. Optional.
	APIKey string `yaml:"api_key"`

	// PairToken is the short-lived token used during the initial pairing
	// handshake. Optional.
	PairToken string `yaml:"pair_token"`

	// HeartbeatIntervalSeconds is how often the agent sends a heartbeat to the
	// server. Default: 30.
	HeartbeatIntervalSeconds int `yaml:"heartbeat_interval_seconds"`

	// ClaimPollIntervalSeconds is how often the agent polls for new print jobs.
	// Default: 5.
	ClaimPollIntervalSeconds int `yaml:"claim_poll_interval_seconds"`

	// DefaultFilamentDensityGCm3 is the fallback filament density in g/cm³
	// when no per-spool value is available. Default: 1.24.
	DefaultFilamentDensityGCm3 float64 `yaml:"default_filament_density_g_cm3"`

	// DefaultFilamentDiameterMm is the fallback filament diameter in mm.
	// Default: 1.75.
	DefaultFilamentDiameterMm float64 `yaml:"default_filament_diameter_mm"`
}

// Load reads the configuration using the real OS environment and the default
// config path ($COURIER_CONFIG_PATH or /config/courier.yml).
func Load() (*Config, error) {
	return LoadFromPath(configPath(os.Getenv), os.Getenv)
}

// LoadFromPath is the injectable variant used by tests.  It reads from path
// (absent file is not fatal) and then applies environment overrides via getenv.
func LoadFromPath(path string, getenv func(string) string) (*Config, error) {
	cfg := &Config{}

	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("config: reading file %q: %w", path, err)
	}
	if err == nil {
		if yamlErr := yaml.Unmarshal(data, cfg); yamlErr != nil {
			return nil, fmt.Errorf("config: parsing YAML in %q: %w", path, yamlErr)
		}
	}

	applyEnvOverrides(cfg, getenv)
	applyDefaults(cfg)

	if err := validate(cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}

// configPath resolves the YAML file path from the environment, falling back to
// the built-in default.
func configPath(getenv func(string) string) string {
	if p := getenv("COURIER_CONFIG_PATH"); p != "" {
		return p
	}
	return defaultConfigPath
}

// applyEnvOverrides overwrites string/int/float fields when the matching
// environment variable is non-empty.
func applyEnvOverrides(cfg *Config, getenv func(string) string) {
	if v := getenv("COURIER_SERVER_URL"); v != "" {
		cfg.ServerURL = v
	}
	if v := getenv("COURIER_NAME"); v != "" {
		cfg.Name = v
	}
	if v := getenv("COURIER_API_KEY"); v != "" {
		cfg.APIKey = v
	}
	if v := getenv("COURIER_PAIR_TOKEN"); v != "" {
		cfg.PairToken = v
	}
}

// applyDefaults fills in zero-value numeric fields with their documented
// defaults so callers never see a zero.
func applyDefaults(cfg *Config) {
	if cfg.HeartbeatIntervalSeconds == 0 {
		cfg.HeartbeatIntervalSeconds = defaultHeartbeatIntervalSecs
	}
	if cfg.ClaimPollIntervalSeconds == 0 {
		cfg.ClaimPollIntervalSeconds = defaultClaimPollIntervalSecs
	}
	if cfg.DefaultFilamentDensityGCm3 == 0 {
		cfg.DefaultFilamentDensityGCm3 = defaultFilamentDensityGCm3
	}
	if cfg.DefaultFilamentDiameterMm == 0 {
		cfg.DefaultFilamentDiameterMm = defaultFilamentDiameterMm
	}
}

// validate returns a combined error listing every missing required field.
func validate(cfg *Config) error {
	var missing []string
	if cfg.ServerURL == "" {
		missing = append(missing, "server_url")
	}
	if cfg.Name == "" {
		missing = append(missing, "name")
	}
	if len(missing) == 0 {
		return nil
	}
	if len(missing) == 1 {
		return fmt.Errorf("config: missing required field %q", missing[0])
	}
	return fmt.Errorf("config: missing required fields %v", missing)
}

