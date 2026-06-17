// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package moonraker implements the Moonraker (Klipper) HTTP-multipart upload
// dispatch adapter for the lootgoblin courier.
package moonraker

import (
	"encoding/json"
	"fmt"
)

// ConnectionConfig holds the per-printer connection parameters for a
// Moonraker/Klipper instance.  Defaults mirror Moonraker's documented defaults.
type ConnectionConfig struct {
	Host         string // required; empty string is invalid
	Port         int    // default 7125
	Scheme       string // "http" or "https"; default "http"
	StartPrint   bool   // default true
	RequiresAuth bool   // default true
}

// Credential holds the decrypted credential payload for a Moonraker printer.
// APIKey is the value to send in the X-Api-Key header when non-empty.
type Credential struct {
	APIKey string
}

// connectionConfigRaw is the JSON shape received in the claim bundle.  All
// fields are pointers so we can detect absence and apply defaults.
type connectionConfigRaw struct {
	Host         string  `json:"host"`
	Port         *int    `json:"port"`
	Scheme       *string `json:"scheme"`
	StartPrint   *bool   `json:"startPrint"`
	RequiresAuth *bool   `json:"requiresAuth"`
}

// credentialRaw is the JSON shape of the decrypted credential payload.
type credentialRaw struct {
	APIKey string `json:"apiKey"`
}

// ParseConnectionConfig unmarshals raw JSON into a ConnectionConfig, applying
// defaults for absent fields:
//   - Port → 7125
//   - Scheme → "http"
//   - StartPrint → true
//   - RequiresAuth → true
//
// An empty or missing host is an error.
func ParseConnectionConfig(raw json.RawMessage) (ConnectionConfig, error) {
	var r connectionConfigRaw
	if err := json.Unmarshal(raw, &r); err != nil {
		return ConnectionConfig{}, fmt.Errorf("moonraker: parse connection_config: %w", err)
	}

	if r.Host == "" {
		return ConnectionConfig{}, fmt.Errorf("moonraker: connection_config.host is required")
	}

	cfg := ConnectionConfig{
		Host:         r.Host,
		Port:         7125,
		Scheme:       "http",
		StartPrint:   true,
		RequiresAuth: true,
	}

	if r.Port != nil {
		cfg.Port = *r.Port
	}
	if r.Scheme != nil {
		if *r.Scheme != "http" && *r.Scheme != "https" {
			return ConnectionConfig{}, fmt.Errorf("moonraker: connection_config.scheme must be \"http\" or \"https\", got %q", *r.Scheme)
		}
		cfg.Scheme = *r.Scheme
	}
	if r.StartPrint != nil {
		cfg.StartPrint = *r.StartPrint
	}
	if r.RequiresAuth != nil {
		cfg.RequiresAuth = *r.RequiresAuth
	}

	return cfg, nil
}

// ParseCredential unmarshals raw JSON into a Credential.  A nil or empty raw
// message is accepted and returns a zero Credential (no API key), matching the
// trusted-clients / no-auth mode.
func ParseCredential(raw json.RawMessage) (Credential, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return Credential{}, nil
	}
	var r credentialRaw
	if err := json.Unmarshal(raw, &r); err != nil {
		return Credential{}, fmt.Errorf("moonraker: parse credential payload: %w", err)
	}
	return Credential(r), nil
}
