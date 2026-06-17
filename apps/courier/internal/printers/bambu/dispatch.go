// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package bambu

// dispatch.go — Bambu LAN dispatch orchestration.
//
// Wires together: ParseConnectionConfig → ParseCredential → AMS extraction →
// FTPS upload → MQTT publish.
//
// Dispatch is the entry point PART 2 will wrap into a printers.Dispatcher
// adapter when it registers the protocol.  All dependencies (AMS extractor,
// FTPS dialer, MQTT factory, timeoutMs) are injectable for unit testing.
//
// Failure mapping mirrors adapter.ts:
//   - Bad config / cred JSON → unknown
//   - Non-3MF file extension → rejected
//   - FTP connect fail → unreachable / auth-failed / timeout / unknown
//   - MQTT connect fail → unreachable / auth-failed / timeout / unknown
//   - startPrint=false → success after upload only (no MQTT)

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// DispatchDeps bundles all injectable dependencies for Dispatch.  All fields
// are optional; nil values fall back to production defaults.
type DispatchDeps struct {
	// AmsExtractor overrides ExtractAmsConfig for unit tests.
	AmsExtractor func(path string, log *slog.Logger) AmsConfig
	// FtpDialer overrides DefaultFtpDialer for unit tests.
	FtpDialer FtpDialer
	// MqttFactory overrides DefaultMqttClientFactory for unit tests.
	MqttFactory MqttClientFactory
	// TimeoutMs overrides DefaultBambuTimeoutMs (0 = use default).
	TimeoutMs int
}

// Dispatch is the top-level Bambu LAN dispatch function.  It:
//  1. Parses connection config + credential from raw JSON.
//  2. Validates the artifact file extension (.gcode.3mf or .3mf).
//  3. Extracts AMS slot mapping from the 3MF ZIP.
//  4. Uploads the file via FTPS to /cache/<filename>.
//  5. Publishes the MQTT project_file command (unless startPrint=false).
//
// cfg and cred are the raw JSON blobs from the dispatch claim bundle.
// Part 2 calls this from the printers.Dispatcher adapter.
func Dispatch(
	ctx context.Context,
	cfg json.RawMessage,
	cred json.RawMessage,
	artifactPath string,
	log *slog.Logger,
	deps DispatchDeps,
) printers.DispatchOutcome {
	if log == nil {
		log = slog.Default()
	}

	// 1. Parse connection config.
	connCfg, err := ParseConnectionConfig(cfg)
	if err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: fmt.Sprintf("invalid connection-config: %s", err.Error()),
		}
	}

	// 2. Parse credential.
	credPayload, err := ParseCredential(cred)
	if err != nil {
		return printers.DispatchOutcome{
			Reason:  "auth-failed",
			Details: fmt.Sprintf("credential payload missing or wrong shape: %s", err.Error()),
		}
	}

	// 3. Validate file extension.
	lower := strings.ToLower(artifactPath)
	if !strings.HasSuffix(lower, ".gcode.3mf") && !strings.HasSuffix(lower, ".3mf") {
		return printers.DispatchOutcome{
			Reason:  "rejected",
			Details: "Bambu printers require .gcode.3mf from Bambu Studio",
		}
	}
	filename := filepath.Base(artifactPath)

	// 4. Extract AMS config.
	extractor := deps.AmsExtractor
	if extractor == nil {
		extractor = ExtractAmsConfig
	}
	ams := extractor(artifactPath, log)
	useAms := ams.UseAms && !connCfg.ForceAmsDisabled
	amsMapping := ams.AmsMapping
	if !useAms {
		amsMapping = []int{}
	}

	// 5. FTPS upload.
	ftpResult := UploadArtifact(ctx, connCfg, credPayload, artifactPath, deps.FtpDialer)
	if !ftpResult.OK {
		log.Warn("bambu: FTP upload failed",
			"ip", connCfg.IP,
			"serial", credPayload.Serial,
			"filename", filename,
			"reason", ftpResult.Reason,
		)
		return printers.DispatchOutcome{
			Reason:  ftpResult.Reason,
			Details: excerpt(ftpResult.Detail),
		}
	}

	remoteFilename := "/cache/" + filename

	// 6. Upload-only short-circuit.
	if !connCfg.StartPrint {
		log.Info("bambu: upload-only dispatch succeeded",
			"ip", connCfg.IP,
			"serial", credPayload.Serial,
			"filename", filename,
			"useAms", false,
			"amsSlots", 0,
			"startPrint", false,
		)
		return printers.DispatchOutcome{OK: true, RemoteFilename: remoteFilename}
	}

	// 7. Build + publish MQTT print command.
	cmd := BuildPrintCommand(connCfg, filename, ams, useAms, amsMapping)
	payloadBytes, err := json.Marshal(cmd)
	if err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: fmt.Sprintf("failed to marshal MQTT payload: %s", err.Error()),
		}
	}

	clientID := "lootgoblin-" + randomHex(16)
	mqttResult := PublishPrintCommand(ctx, connCfg, credPayload, clientID, payloadBytes, deps.MqttFactory, deps.TimeoutMs)
	if !mqttResult.OK {
		log.Warn("bambu: MQTT dispatch failed",
			"ip", connCfg.IP,
			"serial", credPayload.Serial,
			"filename", filename,
			"reason", mqttResult.Reason,
		)
		return printers.DispatchOutcome{
			Reason:  mqttResult.Reason,
			Details: excerpt(mqttResult.Detail),
		}
	}

	log.Info("bambu: dispatch succeeded",
		"ip", connCfg.IP,
		"serial", credPayload.Serial,
		"filename", filename,
		"useAms", useAms,
		"amsSlots", len(amsMapping),
	)
	return printers.DispatchOutcome{OK: true, RemoteFilename: remoteFilename}
}

// randomHex returns n random hex bytes (2*n hex chars).
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "00000000"
	}
	return hex.EncodeToString(b)
}

const detailsExcerptMax = 500

func excerpt(s string) string {
	if len(s) > detailsExcerptMax {
		return s[:detailsExcerptMax]
	}
	return s
}
