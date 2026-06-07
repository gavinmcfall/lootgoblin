// Package octoprint implements the OctoPrint HTTP-multipart upload dispatch
// adapter and SockJS status subscriber for the lootgoblin courier.
package octoprint

import (
	"encoding/json"
	"fmt"
)

// Kind is the printer.Kind value registered for OctoPrint printers.
const Kind = "fdm_octoprint"

// ConnectionConfig holds the per-printer connection parameters for an
// OctoPrint instance. Defaults mirror OctoPrint's documented defaults.
type ConnectionConfig struct {
	Host         string // required; empty string is invalid
	Port         int    // default 80
	Scheme       string // "http" or "https"; default "http"
	APIPath      string // default "/api"
	Select       bool   // default true
	StartPrint   bool   // default true
	RequiresAuth bool   // default true
}

// Credential holds the decrypted credential payload for an OctoPrint printer.
// APIKey is the value to send in the X-Api-Key header when non-empty.
type Credential struct {
	APIKey string
}

// connectionConfigRaw is the JSON shape received in the claim bundle. All
// fields are pointers so we can detect absence and apply defaults.
type connectionConfigRaw struct {
	Host         string  `json:"host"`
	Port         *int    `json:"port"`
	Scheme       *string `json:"scheme"`
	APIPath      *string `json:"apiPath"`
	Select       *bool   `json:"select"`
	StartPrint   *bool   `json:"startPrint"`
	RequiresAuth *bool   `json:"requiresAuth"`
}

// credentialRaw is the JSON shape of the decrypted credential payload.
type credentialRaw struct {
	APIKey string `json:"apiKey"`
}

// ParseConnectionConfig unmarshals raw JSON into a ConnectionConfig, applying
// defaults for absent fields:
//   - Port → 80
//   - Scheme → "http"
//   - APIPath → "/api"
//   - Select → true
//   - StartPrint → true
//   - RequiresAuth → true
//
// An empty or missing host is an error.
func ParseConnectionConfig(raw json.RawMessage) (ConnectionConfig, error) {
	var r connectionConfigRaw
	if err := json.Unmarshal(raw, &r); err != nil {
		return ConnectionConfig{}, fmt.Errorf("octoprint: parse connection_config: %w", err)
	}

	if r.Host == "" {
		return ConnectionConfig{}, fmt.Errorf("octoprint: connection_config.host is required")
	}

	cfg := ConnectionConfig{
		Host:         r.Host,
		Port:         80,
		Scheme:       "http",
		APIPath:      "/api",
		Select:       true,
		StartPrint:   true,
		RequiresAuth: true,
	}

	if r.Port != nil {
		cfg.Port = *r.Port
	}
	if r.Scheme != nil {
		if *r.Scheme != "http" && *r.Scheme != "https" {
			return ConnectionConfig{}, fmt.Errorf("octoprint: connection_config.scheme must be \"http\" or \"https\", got %q", *r.Scheme)
		}
		cfg.Scheme = *r.Scheme
	}
	if r.APIPath != nil {
		cfg.APIPath = *r.APIPath
	}
	if r.Select != nil {
		cfg.Select = *r.Select
	}
	if r.StartPrint != nil {
		cfg.StartPrint = *r.StartPrint
	}
	if r.RequiresAuth != nil {
		cfg.RequiresAuth = *r.RequiresAuth
	}

	return cfg, nil
}

// ParseCredential unmarshals raw JSON into a Credential. A nil or empty raw
// message is accepted and returns a zero Credential (no API key), matching the
// no-auth / trusted mode.
func ParseCredential(raw json.RawMessage) (Credential, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return Credential{}, nil
	}
	var r credentialRaw
	if err := json.Unmarshal(raw, &r); err != nil {
		return Credential{}, fmt.Errorf("octoprint: parse credential payload: %w", err)
	}
	return Credential{APIKey: r.APIKey}, nil
}
