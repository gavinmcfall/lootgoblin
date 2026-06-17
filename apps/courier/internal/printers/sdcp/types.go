// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package sdcp implements the SDCP 3.0 open-protocol resin printer adapter
// (Elegoo Saturn/Mars families and any other firmware that speaks the unified
// SDCP 3.0 upload + WebSocket command protocol).
//
// Protocol characteristics:
//   - No authentication at the protocol level.
//   - File upload: chunked multipart HTTP POST to /uploadFile/upload, 1 MiB chunks.
//   - Start-print: WebSocket JSON Cmd 128 on ws://<ip>:<port>/websocket.
//   - Status: WebSocket JSON push on sdcp/status/<MainboardID>, optional Cmd 0 subscribe.
//   - Keepalive: WebSocket ping every 30 s (printer drops idle connections at 60 s).
package sdcp

import (
	"encoding/json"
	"fmt"
)

// Kinds is the complete set of SDCP per-model printer kinds registered by this
// package. Copied verbatim from
// apps/server/src/forge/dispatch/sdcp/types.ts SDCP_KINDS.
var Kinds = []string{
	"sdcp_elegoo_saturn_4",
	"sdcp_elegoo_saturn_4_ultra",
	"sdcp_elegoo_mars_5",
	"sdcp_elegoo_mars_5_ultra",
	"sdcp_elegoo_saturn_3_ultra",
	"sdcp_elegoo_mars_4_ultra",
	"sdcp_elegoo_saturn_2",
	"sdcp_elegoo_mars_3",
}

// ConnectionConfig holds the per-printer connection parameters for an SDCP
// resin printer. Mirrors SdcpConnectionConfig in types.ts.
type ConnectionConfig struct {
	IP          string // required
	MainboardID string // required
	Port        int    // default 3030
	StartPrint  bool   // default true
	StartLayer  int    // default 0
}

// Credential is the SDCP credential payload. SDCP 3.0 has no authentication;
// the credential row is optional and the payload is always empty.
type Credential struct{}

// connectionConfigRaw is the JSON shape received in the claim bundle.
type connectionConfigRaw struct {
	IP          string `json:"ip"`
	MainboardID string `json:"mainboardId"`
	Port        *int   `json:"port"`
	StartPrint  *bool  `json:"startPrint"`
	StartLayer  *int   `json:"startLayer"`
}

// ParseConnectionConfig unmarshals raw JSON into a ConnectionConfig, applying
// defaults:
//   - Port → 3030
//   - StartPrint → true
//   - StartLayer → 0
//
// An empty or missing ip/mainboardId is an error.
func ParseConnectionConfig(raw json.RawMessage) (ConnectionConfig, error) {
	var r connectionConfigRaw
	if err := json.Unmarshal(raw, &r); err != nil {
		return ConnectionConfig{}, fmt.Errorf("sdcp: parse connection_config: %w", err)
	}
	if r.IP == "" {
		return ConnectionConfig{}, fmt.Errorf("sdcp: connection_config.ip is required")
	}
	if r.MainboardID == "" {
		return ConnectionConfig{}, fmt.Errorf("sdcp: connection_config.mainboardId is required")
	}

	cfg := ConnectionConfig{
		IP:          r.IP,
		MainboardID: r.MainboardID,
		Port:        3030,
		StartPrint:  true,
		StartLayer:  0,
	}
	if r.Port != nil {
		cfg.Port = *r.Port
	}
	if r.StartPrint != nil {
		cfg.StartPrint = *r.StartPrint
	}
	if r.StartLayer != nil {
		cfg.StartLayer = *r.StartLayer
	}
	return cfg, nil
}

// ParseCredential accepts an empty or null credential (SDCP has no auth).
// Always returns a zero Credential.
func ParseCredential(_ json.RawMessage) (Credential, error) {
	return Credential{}, nil
}
