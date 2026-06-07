// Package bambu implements the Bambu Lab LAN-mode printer dispatch adapter for
// the lootgoblin Courier.  Part 1 ships the types, AMS extractor, FTPS upload
// and MQTT publish surface.  Part 2 (separate task) adds the status subscriber
// and registers the protocol with the registry.
//
// Protocol summary:
//   - FTPS (implicit TLS, port 990) to upload the .gcode.3mf into /cache/.
//   - MQTTS (TLS, port 8883) to publish a project_file print command on
//     topic device/<serial>/request.
//
// Both connections use self-signed device certificates (InsecureSkipVerify:true).
// The security boundary is the LAN — TLS is for link confidentiality only.
//
// Kinds: 13 per-model bambu_* strings (copied verbatim from types.ts).
// Registration is deferred to Part 2.
package bambu

import (
	"encoding/json"
	"fmt"
)

// Kinds is the complete set of Bambu LAN per-model printer kinds that this
// package handles.  Copied verbatim from BAMBU_LAN_KINDS in types.ts.
// Part 2 passes this slice to printers.Register.
var Kinds = []string{
	// H2 series — multi-function (print + laser + cut + plot)
	"bambu_h2d",
	"bambu_h2d_pro",
	"bambu_h2c",
	"bambu_h2s",
	// X series
	"bambu_x2d",
	// P series
	"bambu_p2s",
	"bambu_p1s",
	"bambu_p1p",
	// A series
	"bambu_a1",
	"bambu_a1_mini",
	// X1 series — EOL 2026-03-31, still supported in homes
	"bambu_x1c",
	"bambu_x1e",
	"bambu_x1",
}

// ModelCapability holds per-model capability data for a Bambu LAN printer.
// Mirrors BambuModelCapability in types.ts.
type ModelCapability struct {
	// MaxAmsUnits is the maximum number of AMS 2 Pro / AMS units that can be
	// daisy-chained.
	MaxAmsUnits int
	// MaxAmsSlots is the maximum total filament slots across all AMS units
	// (excluding the external spool).
	MaxAmsSlots int
	// BedSizeMm is the build-volume in mm (X, Y, Z).
	BedSizeMm struct{ X, Y, Z int }
	// HasHeatedChamber indicates an actively heated enclosure.
	HasHeatedChamber bool
	// SupportsAmsHt indicates support for AMS HT (high-temp) modules.
	SupportsAmsHt bool
	// IsMultiFunction indicates H2-series laser/cut/plot capability.
	IsMultiFunction bool
	// DisplayName is the human-readable model name for UI and error messages.
	DisplayName string
}

// ModelCapabilities maps each Bambu LAN kind to its capability data.
// Copied verbatim from BAMBU_MODEL_CAPABILITIES in types.ts.
//
// NOTE (from types.ts): capability values are initial best-effort from
// research against Bambu's official spec pages.  Refine when authoritative
// spec data becomes available — especially AMS unit / slot maxima for the
// multi-function H2 line.
var ModelCapabilities = map[string]ModelCapability{
	// H2 series — multi-function, dual-nozzle (except H2S)
	"bambu_h2d": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{350, 320, 325},
		HasHeatedChamber: true,
		SupportsAmsHt:    true,
		IsMultiFunction:  true,
		DisplayName:      "Bambu Lab H2D",
	},
	"bambu_h2d_pro": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{350, 320, 325},
		HasHeatedChamber: true,
		SupportsAmsHt:    true,
		IsMultiFunction:  true,
		DisplayName:      "Bambu Lab H2D Pro",
	},
	"bambu_h2c": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{350, 320, 325},
		HasHeatedChamber: true,
		SupportsAmsHt:    true,
		IsMultiFunction:  true,
		DisplayName:      "Bambu Lab H2C",
	},
	"bambu_h2s": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{350, 320, 350},
		HasHeatedChamber: true,
		SupportsAmsHt:    true,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab H2S",
	},
	// X series
	"bambu_x2d": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{256, 256, 256},
		HasHeatedChamber: false,
		SupportsAmsHt:    false,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab X2D",
	},
	// P series
	"bambu_p2s": {
		MaxAmsUnits:      8,
		MaxAmsSlots:      20,
		BedSizeMm:        struct{ X, Y, Z int }{256, 256, 256},
		HasHeatedChamber: false,
		SupportsAmsHt:    true,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab P2S",
	},
	"bambu_p1s": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{256, 256, 256},
		HasHeatedChamber: false,
		SupportsAmsHt:    false,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab P1S",
	},
	"bambu_p1p": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{256, 256, 256},
		HasHeatedChamber: false,
		SupportsAmsHt:    false,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab P1P",
	},
	// A series
	"bambu_a1": {
		MaxAmsUnits:      1,
		MaxAmsSlots:      4,
		BedSizeMm:        struct{ X, Y, Z int }{256, 256, 256},
		HasHeatedChamber: false,
		SupportsAmsHt:    false,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab A1",
	},
	"bambu_a1_mini": {
		MaxAmsUnits:      0,
		MaxAmsSlots:      0,
		BedSizeMm:        struct{ X, Y, Z int }{180, 180, 180},
		HasHeatedChamber: false,
		SupportsAmsHt:    false,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab A1 mini",
	},
	// X1 series — EOL 2026-03-31
	"bambu_x1c": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{256, 256, 256},
		HasHeatedChamber: false,
		SupportsAmsHt:    false,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab X1 Carbon (EOL)",
	},
	"bambu_x1e": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{256, 256, 256},
		HasHeatedChamber: true,
		SupportsAmsHt:    false,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab X1E (EOL)",
	},
	"bambu_x1": {
		MaxAmsUnits:      4,
		MaxAmsSlots:      16,
		BedSizeMm:        struct{ X, Y, Z int }{256, 256, 256},
		HasHeatedChamber: false,
		SupportsAmsHt:    false,
		IsMultiFunction:  false,
		DisplayName:      "Bambu Lab X1 (EOL)",
	},
}

// IsBambuLanKind returns true if kind is one of the 13 per-model bambu_* kinds.
func IsBambuLanKind(kind string) bool {
	for _, k := range Kinds {
		if k == kind {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// ConnectionConfig
// ---------------------------------------------------------------------------

// ConnectionConfig holds the per-printer connection parameters for a Bambu LAN
// printer.  Mirrors BambuLanConnectionConfigT in types.ts.
type ConnectionConfig struct {
	IP                 string
	MqttPort           int
	FtpPort            int
	StartPrint         bool
	ForceAmsDisabled   bool
	PlateIndex         int
	BedLevelling       bool
	FlowCalibration    bool
	VibrationCal       bool
	LayerInspect       bool
	Timelapse          bool
	BedType            string
}

// connectionConfigRaw is the JSON shape received in the claim bundle.  Pointer
// fields allow absence detection so defaults can be applied.
type connectionConfigRaw struct {
	IP               string  `json:"ip"`
	MqttPort         *int    `json:"mqttPort"`
	FtpPort          *int    `json:"ftpPort"`
	StartPrint       *bool   `json:"startPrint"`
	ForceAmsDisabled *bool   `json:"forceAmsDisabled"`
	PlateIndex       *int    `json:"plateIndex"`
	BedLevelling     *bool   `json:"bedLevelling"`
	FlowCalibration  *bool   `json:"flowCalibration"`
	VibrationCal     *bool   `json:"vibrationCalibration"`
	LayerInspect     *bool   `json:"layerInspect"`
	Timelapse        *bool   `json:"timelapse"`
	BedType          *string `json:"bedType"`
}

// validBedTypes is the set of accepted bedType values (mirrors the Zod enum in
// types.ts).
var validBedTypes = map[string]bool{
	"auto":              true,
	"cool_plate":        true,
	"engineering_plate": true,
	"high_temp_plate":   true,
	"textured_pei_plate": true,
	"pei_plate":         true,
}

// ParseConnectionConfig unmarshals raw JSON into a ConnectionConfig, applying
// defaults:
//   - MqttPort           → 8883
//   - FtpPort            → 990
//   - StartPrint         → true
//   - ForceAmsDisabled   → false
//   - PlateIndex         → 1
//   - BedLevelling       → true
//   - FlowCalibration    → true
//   - VibrationCalibration → true
//   - LayerInspect       → false
//   - Timelapse          → false
//   - BedType            → "auto"
//
// An empty ip is an error.
func ParseConnectionConfig(raw json.RawMessage) (ConnectionConfig, error) {
	var r connectionConfigRaw
	if err := json.Unmarshal(raw, &r); err != nil {
		return ConnectionConfig{}, fmt.Errorf("bambu: parse connection_config: %w", err)
	}
	if r.IP == "" {
		return ConnectionConfig{}, fmt.Errorf("bambu: connection_config.ip is required")
	}

	cfg := ConnectionConfig{
		IP:               r.IP,
		MqttPort:         8883,
		FtpPort:          990,
		StartPrint:       true,
		ForceAmsDisabled: false,
		PlateIndex:       1,
		BedLevelling:     true,
		FlowCalibration:  true,
		VibrationCal:     true,
		LayerInspect:     false,
		Timelapse:        false,
		BedType:          "auto",
	}

	if r.MqttPort != nil {
		cfg.MqttPort = *r.MqttPort
	}
	if r.FtpPort != nil {
		cfg.FtpPort = *r.FtpPort
	}
	if r.StartPrint != nil {
		cfg.StartPrint = *r.StartPrint
	}
	if r.ForceAmsDisabled != nil {
		cfg.ForceAmsDisabled = *r.ForceAmsDisabled
	}
	if r.PlateIndex != nil {
		if *r.PlateIndex < 1 {
			return ConnectionConfig{}, fmt.Errorf("bambu: connection_config.plateIndex must be >= 1")
		}
		cfg.PlateIndex = *r.PlateIndex
	}
	if r.BedLevelling != nil {
		cfg.BedLevelling = *r.BedLevelling
	}
	if r.FlowCalibration != nil {
		cfg.FlowCalibration = *r.FlowCalibration
	}
	if r.VibrationCal != nil {
		cfg.VibrationCal = *r.VibrationCal
	}
	if r.LayerInspect != nil {
		cfg.LayerInspect = *r.LayerInspect
	}
	if r.Timelapse != nil {
		cfg.Timelapse = *r.Timelapse
	}
	if r.BedType != nil {
		if !validBedTypes[*r.BedType] {
			return ConnectionConfig{}, fmt.Errorf("bambu: connection_config.bedType %q is not valid", *r.BedType)
		}
		cfg.BedType = *r.BedType
	}

	return cfg, nil
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

// Credential holds the decrypted credential payload for a Bambu LAN printer.
// Mirrors BambuLanCredentialPayloadT in types.ts.
//
//   - AccessCode — 8-char alphanumeric LAN access code (shown on the printer
//     LCD: Settings → WLAN → LAN Mode).  Used as both the FTPS and MQTTS
//     password.  The fixed username for both protocols is BambuLanUsername.
//   - Serial — printer serial number; used as the MQTT topic prefix
//     device/<serial>/request.
//
// Logging policy: NEVER log AccessCode.  Serial is safe to log.
type Credential struct {
	AccessCode string
	Serial     string
}

// credentialRaw is the JSON shape of the decrypted credential payload.
type credentialRaw struct {
	AccessCode string `json:"accessCode"`
	Serial     string `json:"serial"`
}

// ParseCredential unmarshals raw JSON into a Credential.  Both accessCode and
// serial are required.
func ParseCredential(raw json.RawMessage) (Credential, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return Credential{}, fmt.Errorf("bambu: credential is required (accessCode + serial)")
	}
	var r credentialRaw
	if err := json.Unmarshal(raw, &r); err != nil {
		return Credential{}, fmt.Errorf("bambu: parse credential: %w", err)
	}
	if r.AccessCode == "" {
		return Credential{}, fmt.Errorf("bambu: credential.accessCode is required")
	}
	if r.Serial == "" {
		return Credential{}, fmt.Errorf("bambu: credential.serial is required")
	}
	return Credential(r), nil
}

// BambuLanUsername is the Bambu LAN protocol-defined client username — NOT a
// credential.  Every Bambu printer in LAN mode accepts "bblp" as the literal
// MQTT/FTPS username; the actual secret is the per-printer Access Code.
//
// Extracted to a constant to avoid co-locating username + password literals in
// object literals (static-analysis heuristic avoidance).
//
// References: davglass/bambu-cli, Doridian/OpenBambuAPI mqtt.md.
//
//nolint:gosec // pragma: allowlist secret — "bblp" is a protocol constant, not a secret
const BambuLanUsername = "bblp"
