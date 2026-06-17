// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package bambu

// ams.go — AMS (Automatic Material System) metadata extractor.
//
// Ports ams-extractor.ts (V2-005d-b T_db2) faithfully.
//
// A Bambu Studio / OrcaSlicer .gcode.3mf export is a ZIP archive.  The
// relevant entry is Metadata/slice_info.config, an XML document containing
// per-plate <filament> slot data.  When AMS is enabled, each filament used by
// the sliced plate appears as a <filament> element whose id attribute holds the
// AMS slot index (0-based).
//
// NEVER panics — every failure path falls back to safe defaults so the
// dispatcher can still attempt a single-colour print.
//
// XML schema assumption (T_db5 will validate against real Bambu output):
//
//	<config>
//	  <plate>
//	    <metadata key="index" value="1"/>
//	    <filament id="0" .../>
//	    <filament id="1" .../>
//	    ...
//	  </plate>
//	</config>
//
// The extractor walks defensively: it accepts <filament> elements at any depth
// and pulls slot indexes from id, index, or slot attributes, preferring id.
//
// AMS multi-colour requires 2+ filament slots.  A single-filament entry is just
// the active material — not AMS-driven.  Treat <2 as no-AMS (matches Node).

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
)

const sliceInfoPath = "Metadata/slice_info.config"

// AmsConfig is the result of extracting AMS metadata from a .gcode.3mf file.
// Mirrors the AmsConfig interface in ams-extractor.ts.
type AmsConfig struct {
	// UseAms is true if the 3MF was sliced with AMS enabled (≥2 filament slots).
	UseAms bool
	// AmsMapping is the ordered slice of AMS slot indexes used for the print,
	// e.g. [0, 1, 2, 3] for 4-colour.  Empty when UseAms is false.
	AmsMapping []int
	// PlateIndex is the plate index inside the 3MF.  Default 1.
	// Carry-forward CF-2: multi-plate selection deferred; always 1 for now.
	PlateIndex int
	// SubtaskName is derived from the file basename (minus .gcode.3mf / .3mf
	// suffix) and is included in the MQTT print command.
	SubtaskName string
}

// ExtractAmsConfig reads the ZIP archive at threeMfPath, parses
// Metadata/slice_info.config (XML), and returns the AMS slot mapping +
// subtask name.
//
// On any read/parse failure the function returns safe defaults (UseAms=false)
// so the dispatcher can still attempt a single-colour print.
//
// log may be nil; slog.Default() is used in that case.
func ExtractAmsConfig(threeMfPath string, log *slog.Logger) AmsConfig {
	if log == nil {
		log = slog.Default()
	}
	return extractAmsConfigFromPath(threeMfPath, log)
}

// ExtractAmsConfigFromBytes is the same as ExtractAmsConfig but accepts the
// raw ZIP bytes instead of a filesystem path.  The basename is used for
// SubtaskName derivation.  Provided for unit-testing without a real file.
func ExtractAmsConfigFromBytes(data []byte, basename string, log *slog.Logger) AmsConfig {
	if log == nil {
		log = slog.Default()
	}
	defaults := safeDefaults(basename)

	r, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		log.Warn("ams-extractor: failed to unzip 3MF", "basename", basename, "err", err)
		return defaults
	}

	return extractFromZipReader(r, basename, defaults, log)
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

func extractAmsConfigFromPath(threeMfPath string, log *slog.Logger) AmsConfig {
	defaults := safeDefaults(threeMfPath)

	r, err := zip.OpenReader(threeMfPath)
	if err != nil {
		log.Warn("ams-extractor: failed to open/unzip 3MF", "path", threeMfPath, "err", err)
		return defaults
	}
	defer r.Close()

	return extractFromZipReader(&r.Reader, filepath.Base(threeMfPath), defaults, log)
}

func extractFromZipReader(r *zip.Reader, basename string, defaults AmsConfig, log *slog.Logger) AmsConfig {
	// Locate Metadata/slice_info.config — spec-standard casing first, then
	// case-insensitive fallback (matches Node's JSZip behaviour).
	var entry *zip.File
	for _, f := range r.File {
		if f.Name == sliceInfoPath {
			entry = f
			break
		}
	}
	if entry == nil {
		lower := strings.ToLower(sliceInfoPath)
		for _, f := range r.File {
			if strings.ToLower(f.Name) == lower {
				entry = f
				break
			}
		}
	}
	if entry == nil {
		log.Warn("ams-extractor: slice_info.config not found in 3MF",
			"basename", basename, "entry", sliceInfoPath)
		return defaults
	}

	rc, err := entry.Open()
	if err != nil {
		log.Warn("ams-extractor: failed to open slice_info.config", "basename", basename, "err", err)
		return defaults
	}
	defer rc.Close()

	slots, err := parseSlotIndexes(rc)
	if err != nil {
		log.Warn("ams-extractor: failed to parse slice_info.config XML", "basename", basename, "err", err)
		return defaults
	}

	// AMS multi-colour requires ≥2 filament slots; single-filament = no AMS.
	if len(slots) < 2 {
		return defaults
	}

	return AmsConfig{
		UseAms:      true,
		AmsMapping:  slots,
		PlateIndex:  1,
		SubtaskName: deriveSubtaskName(basename),
	}
}

// xmlFilament is a minimal struct used to decode <filament> elements via the
// standard encoding/xml decoder.  We accept id, index, or slot attributes
// (preferring id) to match the Node extractor's attr-priority logic.
type xmlFilament struct {
	ID    string `xml:"id,attr"`
	Index string `xml:"index,attr"`
	Slot  string `xml:"slot,attr"`
}

// parseSlotIndexes decodes all <filament> elements at any depth from an XML
// reader and returns the ordered list of non-negative slot indexes.
func parseSlotIndexes(rc interface{ Read([]byte) (int, error) }) ([]int, error) {
	dec := xml.NewDecoder(rc)
	var slots []int
	for {
		tok, err := dec.Token()
		if err != nil {
			// io.EOF is the normal termination path.
			break
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "filament" {
			continue
		}
		// Decode into xmlFilament to pick up attributes.
		var f xmlFilament
		if decErr := dec.DecodeElement(&f, &se); decErr != nil {
			// Skip malformed elements; keep walking.
			continue
		}
		if idx := extractSlotIndex(f); idx >= 0 {
			slots = append(slots, idx)
		}
	}
	return slots, nil
}

// extractSlotIndex returns the slot index from a filament element, trying id →
// index → slot in order.  Returns -1 when none of the attributes parse to a
// non-negative integer.
func extractSlotIndex(f xmlFilament) int {
	for _, raw := range []string{f.ID, f.Index, f.Slot} {
		if raw == "" {
			continue
		}
		n, err := strconv.Atoi(raw)
		if err == nil && n >= 0 {
			return n
		}
	}
	return -1
}

// deriveSubtaskName strips .gcode.3mf or .3mf from basename, matching the
// Node deriveSubtaskName helper.
func deriveSubtaskName(p string) string {
	base := filepath.Base(p)
	lower := strings.ToLower(base)
	if strings.HasSuffix(lower, ".gcode.3mf") {
		return base[:len(base)-len(".gcode.3mf")]
	}
	if strings.HasSuffix(lower, ".3mf") {
		return base[:len(base)-len(".3mf")]
	}
	return base
}

func safeDefaults(p string) AmsConfig {
	return AmsConfig{
		UseAms:      false,
		AmsMapping:  []int{},
		PlateIndex:  1,
		SubtaskName: deriveSubtaskName(p),
	}
}
