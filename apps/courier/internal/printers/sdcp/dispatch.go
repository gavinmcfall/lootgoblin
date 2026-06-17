// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package sdcp

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

const (
	// sdcpTimeoutMs is the overall dispatch timeout in milliseconds.
	// Covers chunked upload + WS connect + Cmd 128.
	sdcpTimeoutMs = 120_000
)

// Dispatch uploads a .ctb artifact to the SDCP printer and optionally starts
// the print via Cmd 128.
//
// hc is injectable for tests; pass nil for the default HTTP client.
// dialFn is injectable for commander tests; pass nil for the real dialer.
func Dispatch(
	ctx context.Context,
	cfg ConnectionConfig,
	artifactPath string,
	hc *http.Client,
	log *slog.Logger,
) printers.DispatchOutcome {
	if log == nil {
		log = slog.Default()
	}

	// 1. File-format gate: SDCP only accepts .ctb files.
	filename := filepath.Base(artifactPath)
	if !strings.HasSuffix(strings.ToLower(filename), ".ctb") {
		log.Warn("sdcp: rejected non-.ctb artifact",
			"filename", filename, "mainboardId", cfg.MainboardID)
		return printers.DispatchOutcome{
			Reason:  "rejected",
			Details: "SDCP printers require .ctb format. Slice in Chitubox or Lychee. (Plain .gcode and .gcode.3mf are not accepted.)",
		}
	}

	// 2. Read file into memory.
	data, err := os.ReadFile(artifactPath)
	if err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: "failed to read artifact: " + err.Error(),
		}
	}

	// 3. Upload in 1-MiB chunks.
	sessionUUID := newUUID()
	uploadResult := uploadFileChunked(ctx, cfg, data, filename, sessionUUID, hc, log)
	if !uploadResult.OK {
		log.Warn("sdcp: upload failed",
			"mainboardId", cfg.MainboardID,
			"reason", uploadResult.Reason,
		)
		return printers.DispatchOutcome{
			Reason:  uploadResult.Reason,
			Details: "upload failed: " + uploadResult.Details,
		}
	}

	remoteFilename := "/local/" + filename

	// 4. Upload-only short-circuit.
	if !cfg.StartPrint {
		log.Info("sdcp: upload-only dispatch succeeded",
			"mainboardId", cfg.MainboardID, "filename", filename,
			"sizeBytes", len(data), "startPrint", false,
		)
		return printers.DispatchOutcome{OK: true, RemoteFilename: remoteFilename}
	}

	// 5. Send Cmd 128 (start print).
	idUUID := newUUID()
	requestUUID := newUUID()
	printResult := startPrint(ctx, cfg, filename, idUUID, requestUUID, sdcpTimeoutMs, log)
	if !printResult.OK {
		log.Warn("sdcp: start-print failed",
			"mainboardId", cfg.MainboardID,
			"reason", printResult.Reason,
		)
		return printers.DispatchOutcome{
			Reason:  printResult.Reason,
			Details: "start-print failed: " + printResult.Details,
		}
	}

	log.Info("sdcp: dispatch succeeded",
		"mainboardId", cfg.MainboardID,
		"filename", filename,
		"sizeBytes", len(data),
	)
	return printers.DispatchOutcome{OK: true, RemoteFilename: remoteFilename}
}
