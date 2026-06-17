// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package chitu

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

const magicProbeLen = 16

// Dispatch uploads a slice artifact to a ChituNetwork resin printer and
// optionally starts the print via M6030.
//
// dialFn is injectable for tests; pass nil to use net.Dial.
func Dispatch(
	_ context.Context,
	cfg ConnectionConfig,
	printerKind string,
	artifactPath string,
	dialFn func(addr string) (Conn, error),
	log *slog.Logger,
) printers.DispatchOutcome {
	if log == nil {
		log = slog.Default()
	}

	// 1. Per-model capability lookup.
	cap, ok := modelCapabilities[printerKind]
	if !ok {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: "chitu: unrecognised printer kind: " + printerKind,
		}
	}

	// 2. File-format gate: extension must be in acceptedExtensions.
	filename := filepath.Base(artifactPath)
	ext := fileExt(filename)
	if !containsExt(cap.acceptedExtensions, ext) {
		log.Warn("chitu: rejected unsupported extension",
			"kind", printerKind, "ext", ext, "filename", filename)
		return printers.DispatchOutcome{
			Reason: "rejected",
			Details: cap.displayName + " accepts " + strings.Join(cap.acceptedExtensions, ", ") +
				". Got '" + ext + "'. Slice in Chitubox or Lychee Pro.",
		}
	}

	// 3. Read artifact into memory.
	fileData, err := os.ReadFile(artifactPath)
	if err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: "failed to read artifact: " + err.Error(),
		}
	}

	// 4. Encrypted-CTB gate (pure, before any TCP).
	// Only enforced when encryptedCtbRequired === true AND extension is .ctb.
	// .jxs (Uniformation) is accepted by extension without magic check.
	if cap.encryptedCtbRequired && ext == ".ctb" {
		probeLen := magicProbeLen
		if probeLen > len(fileData) {
			probeLen = len(fileData)
		}
		head := fileData[:probeLen]
		if !IsEncryptedCTB(head) {
			log.Warn("chitu: rejected unencrypted CTB on locked-board kind",
				"kind", printerKind, "filename", filename)
			return printers.DispatchOutcome{
				Reason: "rejected",
				Details: cap.displayName + " requires encrypted CTB. " +
					"Plain/unencrypted CTB will silently fail at the printer. " +
					"Slice in Chitubox Basic/Pro or Lychee Pro with encryption enabled.",
			}
		}
	}

	// 5. Upload + optional start-print via TCP M-codes.
	result := uploadAndPrint(
		cfg.IP,
		cfg.Port,
		filename,
		fileData,
		cfg.StartPrint,
		cfg.StageTimeoutMs,
		dialFn,
	)
	if !result.OK {
		log.Warn("chitu: upload/print failed",
			"kind", printerKind, "ip", cfg.IP,
			"stage", result.Stage, "reason", result.Reason)
		return printers.DispatchOutcome{
			Reason:  result.Reason,
			Details: result.Stage + ": " + result.Details,
		}
	}

	log.Info("chitu: dispatch succeeded",
		"kind", printerKind, "ip", cfg.IP,
		"filename", filename, "sizeBytes", len(fileData))
	return printers.DispatchOutcome{
		OK:             true,
		RemoteFilename: "/local/" + filename,
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func fileExt(name string) string {
	base := strings.ToLower(filepath.Base(name))
	dotIdx := strings.LastIndex(base, ".")
	if dotIdx < 0 {
		return ""
	}
	return base[dotIdx:]
}

func containsExt(accepted []string, ext string) bool {
	for _, a := range accepted {
		if a == ext {
			return true
		}
	}
	return false
}
