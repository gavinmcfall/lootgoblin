// Package chitu implements the ChituBox legacy-network resin printer adapter
// for the Courier. These devices speak an ASCII M-code protocol over a
// persistent TCP connection on port 3000 (Phrozen Sonic 8K family,
// Uniformation GKtwo/GKone, legacy-firmware Elegoo Mars/Saturn).
//
// Protocol: raw TCP M-codes with binary chunk-trailer during upload.
// No authentication; printer is trusted-LAN.
// No measured consumption (resin boards have no per-slot weight tracking).
package chitu

import (
	"encoding/json"
	"fmt"
)

// Kinds is the complete set of ChituNetwork per-model printer kinds registered
// by this package. Copied verbatim from
// apps/server/src/forge/dispatch/chitu-network/types.ts CHITU_NETWORK_KINDS.
var Kinds = []string{
	"chitu_network_phrozen_sonic_mighty_8k",
	"chitu_network_phrozen_sonic_mega_8k",
	"chitu_network_phrozen_sonic_mini_8k",
	"chitu_network_uniformation_gktwo",
	"chitu_network_uniformation_gkone",
	"chitu_network_elegoo_mars_legacy",
	"chitu_network_elegoo_saturn_legacy",
}

// modelCapability holds the per-model capability data for a ChituNetwork
// printer. Mirrors ChituNetworkModelCapability in types.ts.
type modelCapability struct {
	// encryptedCtbRequired is true for locked ChiTu boards (Phrozen Mighty/Mega/Mini 8K,
	// Uniformation GKtwo/GKone) — slicer profile MUST emit encrypted .ctb.
	// false for pre-SDCP open Elegoo boards.
	encryptedCtbRequired bool
	// acceptedExtensions is the list of file extensions accepted by this model
	// e.g. [".ctb"] or [".ctb", ".jxs"].
	acceptedExtensions []string
	// displayName is the human-readable name for use in error messages.
	displayName string
}

// modelCapabilities maps each ChituNetwork kind to its capability data.
// Copied verbatim from CHITU_NETWORK_MODEL_CAPABILITIES in types.ts.
var modelCapabilities = map[string]modelCapability{
	"chitu_network_phrozen_sonic_mighty_8k": {
		encryptedCtbRequired: true,
		acceptedExtensions:   []string{".ctb"},
		displayName:          "Phrozen Sonic Mighty 8K",
	},
	"chitu_network_phrozen_sonic_mega_8k": {
		encryptedCtbRequired: true,
		acceptedExtensions:   []string{".ctb"},
		displayName:          "Phrozen Sonic Mega 8K",
	},
	"chitu_network_phrozen_sonic_mini_8k": {
		encryptedCtbRequired: true,
		acceptedExtensions:   []string{".ctb"},
		displayName:          "Phrozen Sonic Mini 8K",
	},
	"chitu_network_uniformation_gktwo": {
		encryptedCtbRequired: true,
		acceptedExtensions:   []string{".ctb", ".jxs"},
		displayName:          "Uniformation GKtwo",
	},
	"chitu_network_uniformation_gkone": {
		encryptedCtbRequired: true,
		acceptedExtensions:   []string{".ctb"},
		displayName:          "Uniformation GKone",
	},
	"chitu_network_elegoo_mars_legacy": {
		encryptedCtbRequired: false,
		acceptedExtensions:   []string{".ctb", ".cbddlp"},
		displayName:          "Elegoo Mars (legacy firmware)",
	},
	"chitu_network_elegoo_saturn_legacy": {
		encryptedCtbRequired: false,
		acceptedExtensions:   []string{".ctb", ".cbddlp"},
		displayName:          "Elegoo Saturn (legacy firmware)",
	},
}

// ConnectionConfig holds the per-printer connection parameters for a
// ChituNetwork resin printer. Mirrors ChituNetworkConnectionConfig in types.ts.
type ConnectionConfig struct {
	IP             string
	Port           int
	StartPrint     bool
	StageTimeoutMs int
}

// Credential is the ChituNetwork credential payload. ChituNetwork has no
// authentication; the credential row is optional and the payload is always empty.
type Credential struct{}

// connectionConfigRaw is the JSON shape received in the claim bundle.
type connectionConfigRaw struct {
	IP             string `json:"ip"`
	Port           *int   `json:"port"`
	StartPrint     *bool  `json:"startPrint"`
	StageTimeoutMs *int   `json:"stageTimeoutMs"`
}

// ParseConnectionConfig unmarshals raw JSON into a ConnectionConfig, applying
// defaults:
//   - Port → 3000
//   - StartPrint → true
//   - StageTimeoutMs → 60000
//
// An empty or missing ip is an error.
func ParseConnectionConfig(raw json.RawMessage) (ConnectionConfig, error) {
	var r connectionConfigRaw
	if err := json.Unmarshal(raw, &r); err != nil {
		return ConnectionConfig{}, fmt.Errorf("chitu: parse connection_config: %w", err)
	}
	if r.IP == "" {
		return ConnectionConfig{}, fmt.Errorf("chitu: connection_config.ip is required")
	}

	cfg := ConnectionConfig{
		IP:             r.IP,
		Port:           3000,
		StartPrint:     true,
		StageTimeoutMs: 60_000,
	}
	if r.Port != nil {
		cfg.Port = *r.Port
	}
	if r.StartPrint != nil {
		cfg.StartPrint = *r.StartPrint
	}
	if r.StageTimeoutMs != nil {
		cfg.StageTimeoutMs = *r.StageTimeoutMs
	}
	return cfg, nil
}

// ParseCredential accepts an empty or null credential (ChituNetwork has no auth).
// Always returns a zero Credential.
func ParseCredential(_ json.RawMessage) (Credential, error) {
	return Credential{}, nil
}

// ---------------------------------------------------------------------------
// Encrypted-CTB gate — pure, no I/O
// ---------------------------------------------------------------------------

// encryptedCTBMagic is the 4-byte magic for encrypted CTB v4
// (UVtools reverse-engineering reference: last byte 0xc1 vs plain 0xc0).
var encryptedCTBMagic = [4]byte{0x12, 0xfd, 0x90, 0xc1}

// plainCTBMagics are the 4-byte prefixes that identify PLAIN (unencrypted) CTB.
// CTB v3: 0x07 0x00 0x00 0x00; CTB v4 plain: 0x12 0xfd 0x90 0xc0.
var plainCTBMagics = [][4]byte{
	{0x12, 0xfd, 0x90, 0xc0},
	{0x07, 0x00, 0x00, 0x00},
}

// IsEncryptedCTB returns true if the first 4 bytes of head match the encrypted
// CTB v4 signature. Returns false if head is shorter than 4 bytes.
func IsEncryptedCTB(head []byte) bool {
	if len(head) < 4 {
		return false
	}
	return head[0] == encryptedCTBMagic[0] &&
		head[1] == encryptedCTBMagic[1] &&
		head[2] == encryptedCTBMagic[2] &&
		head[3] == encryptedCTBMagic[3]
}

// IsPlainCTB returns true if the first 4 bytes of head match any known plain
// CTB magic (v3 or v4-plain). Returns false if head is shorter than 4 bytes.
func IsPlainCTB(head []byte) bool {
	if len(head) < 4 {
		return false
	}
	for _, magic := range plainCTBMagics {
		if head[0] == magic[0] && head[1] == magic[1] &&
			head[2] == magic[2] && head[3] == magic[3] {
			return true
		}
	}
	return false
}
