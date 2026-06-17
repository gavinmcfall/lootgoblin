// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package bambu

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers — create synthetic .gcode.3mf ZIP fixtures in memory
// ---------------------------------------------------------------------------

// makeThreeMF creates a .gcode.3mf ZIP in memory with a single entry
// Metadata/slice_info.config containing the given XML.
func makeThreeMF(t *testing.T, configXML string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("Metadata/slice_info.config")
	if err != nil {
		t.Fatalf("zip.Create: %v", err)
	}
	if _, err := w.Write([]byte(configXML)); err != nil {
		t.Fatalf("zip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

// makeEmptyThreeMF creates a .gcode.3mf ZIP with no entries.
func makeEmptyThreeMF(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

// writeThreeMF writes ZIP bytes to a temp file and returns the path.
func writeThreeMF(t *testing.T, name string, data []byte) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	return p
}

// ---------------------------------------------------------------------------
// Tests — ExtractAmsConfigFromBytes (no filesystem I/O required)
// ---------------------------------------------------------------------------

// multiColorXML represents a Bambu Studio slice_info.config with 4 AMS filament
// slots — the typical 4-colour AMS print case.
const multiColorXML = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="0" type="PLA" color="FF0000"/>
    <filament id="1" type="PLA" color="00FF00"/>
    <filament id="2" type="PLA" color="0000FF"/>
    <filament id="3" type="PETG" color="FFFFFF"/>
  </plate>
</config>`

func TestExtractAms_MultiColor(t *testing.T) {
	data := makeThreeMF(t, multiColorXML)
	cfg := ExtractAmsConfigFromBytes(data, "model.gcode.3mf", nil)

	if !cfg.UseAms {
		t.Fatal("expected UseAms=true for 4 filaments")
	}
	if len(cfg.AmsMapping) != 4 {
		t.Fatalf("want 4 AMS slots, got %d", len(cfg.AmsMapping))
	}
	for i, slot := range cfg.AmsMapping {
		if slot != i {
			t.Errorf("slot[%d]: want %d, got %d", i, i, slot)
		}
	}
	if cfg.SubtaskName != "model" {
		t.Errorf("subtaskName: want \"model\", got %q", cfg.SubtaskName)
	}
	if cfg.PlateIndex != 1 {
		t.Errorf("plateIndex: want 1, got %d", cfg.PlateIndex)
	}
}

const singleColorXML = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="0" type="PLA" color="FF0000"/>
  </plate>
</config>`

// TestExtractAms_SingleColor verifies that a single-filament 3MF returns
// UseAms=false (single colour = not AMS-driven, matches Node).
func TestExtractAms_SingleColor(t *testing.T) {
	data := makeThreeMF(t, singleColorXML)
	cfg := ExtractAmsConfigFromBytes(data, "single.gcode.3mf", nil)

	if cfg.UseAms {
		t.Fatal("expected UseAms=false for single filament")
	}
	if len(cfg.AmsMapping) != 0 {
		t.Errorf("want empty AmsMapping, got %v", cfg.AmsMapping)
	}
	if cfg.SubtaskName != "single" {
		t.Errorf("subtaskName: want \"single\", got %q", cfg.SubtaskName)
	}
}

// TestExtractAms_NoSliceInfo verifies safe defaults when slice_info.config is
// absent from the ZIP.
func TestExtractAms_NoSliceInfo(t *testing.T) {
	data := makeEmptyThreeMF(t)
	cfg := ExtractAmsConfigFromBytes(data, "noconfig.gcode.3mf", nil)

	if cfg.UseAms {
		t.Fatal("expected UseAms=false when slice_info.config missing")
	}
	if cfg.SubtaskName != "noconfig" {
		t.Errorf("subtaskName: want \"noconfig\", got %q", cfg.SubtaskName)
	}
}

// TestExtractAms_NotAZip verifies safe defaults when given non-ZIP bytes.
func TestExtractAms_NotAZip(t *testing.T) {
	cfg := ExtractAmsConfigFromBytes([]byte("not a zip"), "bad.gcode.3mf", nil)
	if cfg.UseAms {
		t.Fatal("expected UseAms=false for non-ZIP input")
	}
}

// TestExtractAms_MalformedXML verifies safe defaults for unparseable XML.
func TestExtractAms_MalformedXML(t *testing.T) {
	data := makeThreeMF(t, "<<<NOT XML>>>")
	cfg := ExtractAmsConfigFromBytes(data, "bad.gcode.3mf", nil)
	// Malformed XML → no valid <filament> elements → 0 slots → no-AMS defaults.
	if cfg.UseAms {
		t.Fatal("expected UseAms=false for malformed XML")
	}
}

// TestExtractAms_IndexAttrFallback verifies the id→index→slot attribute
// priority logic.
const indexAttrXML = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <filament index="2" type="PLA"/>
    <filament index="3" type="PETG"/>
  </plate>
</config>`

func TestExtractAms_IndexAttrFallback(t *testing.T) {
	data := makeThreeMF(t, indexAttrXML)
	cfg := ExtractAmsConfigFromBytes(data, "idxfallback.gcode.3mf", nil)
	if !cfg.UseAms {
		t.Fatal("expected UseAms=true for 2 filaments via index attr")
	}
	if len(cfg.AmsMapping) != 2 {
		t.Fatalf("want 2 slots, got %d", len(cfg.AmsMapping))
	}
	if cfg.AmsMapping[0] != 2 || cfg.AmsMapping[1] != 3 {
		t.Errorf("want [2,3], got %v", cfg.AmsMapping)
	}
}

// TestExtractAms_SlotAttrFallback verifies the slot attribute fallback.
const slotAttrXML = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <filament slot="0" type="PLA"/>
    <filament slot="1" type="PLA"/>
    <filament slot="2" type="PLA"/>
  </plate>
</config>`

func TestExtractAms_SlotAttrFallback(t *testing.T) {
	data := makeThreeMF(t, slotAttrXML)
	cfg := ExtractAmsConfigFromBytes(data, "slotfallback.gcode.3mf", nil)
	if !cfg.UseAms {
		t.Fatal("expected UseAms=true for 3 filaments via slot attr")
	}
	if len(cfg.AmsMapping) != 3 {
		t.Fatalf("want 3 slots, got %d", len(cfg.AmsMapping))
	}
}

// TestExtractAms_SubtaskNameStripping verifies both suffix variants.
func TestExtractAms_SubtaskNameStripping(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"mymodel.gcode.3mf", "mymodel"},
		{"mymodel.3mf", "mymodel"},
		{"UPPER.GCODE.3MF", "UPPER"},
		{"noext", "noext"},
		{"/some/path/to/file.gcode.3mf", "file"},
	}
	for _, tc := range cases {
		got := deriveSubtaskName(tc.input)
		if got != tc.want {
			t.Errorf("deriveSubtaskName(%q): want %q, got %q", tc.input, tc.want, got)
		}
	}
}

// ---------------------------------------------------------------------------
// Tests — ExtractAmsConfig (filesystem path variant)
// ---------------------------------------------------------------------------

// TestExtractAmsConfig_FileNotFound verifies that a missing file returns safe
// defaults rather than panicking.
func TestExtractAmsConfig_FileNotFound(t *testing.T) {
	cfg := ExtractAmsConfig("/tmp/definitely_does_not_exist_bambu_test.gcode.3mf", nil)
	if cfg.UseAms {
		t.Fatal("expected UseAms=false for missing file")
	}
}

// TestExtractAmsConfig_RealFile verifies the filesystem-path variant against a
// genuine synthetic .gcode.3mf file written to disk.
func TestExtractAmsConfig_RealFile(t *testing.T) {
	data := makeThreeMF(t, multiColorXML)
	path := writeThreeMF(t, "realfile.gcode.3mf", data)

	cfg := ExtractAmsConfig(path, nil)
	if !cfg.UseAms {
		t.Fatal("expected UseAms=true")
	}
	if len(cfg.AmsMapping) != 4 {
		t.Fatalf("want 4 slots, got %d", len(cfg.AmsMapping))
	}
}

// ---------------------------------------------------------------------------
// Tests — IsBambuLanKind
// ---------------------------------------------------------------------------

func TestIsBambuLanKind(t *testing.T) {
	valid := []string{
		"bambu_h2d", "bambu_h2d_pro", "bambu_h2c", "bambu_h2s",
		"bambu_x2d",
		"bambu_p2s", "bambu_p1s", "bambu_p1p",
		"bambu_a1", "bambu_a1_mini",
		"bambu_x1c", "bambu_x1e", "bambu_x1",
	}
	if len(valid) != 13 {
		t.Fatalf("expected 13 kinds, have %d", len(valid))
	}
	for _, k := range valid {
		if !IsBambuLanKind(k) {
			t.Errorf("IsBambuLanKind(%q) = false, want true", k)
		}
		if _, ok := ModelCapabilities[k]; !ok {
			t.Errorf("ModelCapabilities[%q] missing", k)
		}
	}
	if IsBambuLanKind("fdm_bambu_lan") {
		t.Error("fdm_bambu_lan (legacy kind) should not be a BambuLanKind")
	}
	if IsBambuLanKind("") {
		t.Error("empty string should not be a BambuLanKind")
	}
}

// ---------------------------------------------------------------------------
// Tests — ParseConnectionConfig defaults
// ---------------------------------------------------------------------------

func TestParseConnectionConfig_Defaults(t *testing.T) {
	cfg, err := ParseConnectionConfig([]byte(`{"ip":"192.168.1.100"}`))
	if err != nil {
		t.Fatalf("ParseConnectionConfig: %v", err)
	}
	if cfg.IP != "192.168.1.100" {
		t.Errorf("ip: want 192.168.1.100, got %s", cfg.IP)
	}
	if cfg.MqttPort != 8883 {
		t.Errorf("mqttPort default: want 8883, got %d", cfg.MqttPort)
	}
	if cfg.FtpPort != 990 {
		t.Errorf("ftpPort default: want 990, got %d", cfg.FtpPort)
	}
	if !cfg.StartPrint {
		t.Error("startPrint default: want true")
	}
	if cfg.ForceAmsDisabled {
		t.Error("forceAmsDisabled default: want false")
	}
	if cfg.PlateIndex != 1 {
		t.Errorf("plateIndex default: want 1, got %d", cfg.PlateIndex)
	}
	if !cfg.BedLevelling {
		t.Error("bedLevelling default: want true")
	}
	if !cfg.FlowCalibration {
		t.Error("flowCalibration default: want true")
	}
	if !cfg.VibrationCal {
		t.Error("vibrationCalibration default: want true")
	}
	if cfg.LayerInspect {
		t.Error("layerInspect default: want false")
	}
	if cfg.Timelapse {
		t.Error("timelapse default: want false")
	}
	if cfg.BedType != "auto" {
		t.Errorf("bedType default: want auto, got %s", cfg.BedType)
	}
}

func TestParseConnectionConfig_MissingIP(t *testing.T) {
	_, err := ParseConnectionConfig([]byte(`{"mqttPort":8883}`))
	if err == nil {
		t.Fatal("expected error for missing ip")
	}
}

func TestParseConnectionConfig_InvalidBedType(t *testing.T) {
	_, err := ParseConnectionConfig([]byte(`{"ip":"1.2.3.4","bedType":"magic_carpet"}`))
	if err == nil {
		t.Fatal("expected error for invalid bedType")
	}
}

func TestParseConnectionConfig_InvalidPlateIndex(t *testing.T) {
	_, err := ParseConnectionConfig([]byte(`{"ip":"1.2.3.4","plateIndex":0}`))
	if err == nil {
		t.Fatal("expected error for plateIndex < 1")
	}
}

// ---------------------------------------------------------------------------
// Tests — ParseCredential
// ---------------------------------------------------------------------------

func TestParseCredential_Valid(t *testing.T) {
	cred, err := ParseCredential([]byte(`{"accessCode":"ABCD1234","serial":"01P00A123456789"}`))
	if err != nil {
		t.Fatalf("ParseCredential: %v", err)
	}
	if cred.AccessCode != "ABCD1234" {
		t.Errorf("accessCode: want ABCD1234, got %s", cred.AccessCode)
	}
	if cred.Serial != "01P00A123456789" {
		t.Errorf("serial: want 01P00A123456789, got %s", cred.Serial)
	}
}

func TestParseCredential_MissingAccessCode(t *testing.T) {
	_, err := ParseCredential([]byte(`{"serial":"01P00A123456789"}`))
	if err == nil {
		t.Fatal("expected error for missing accessCode")
	}
}

func TestParseCredential_MissingSerial(t *testing.T) {
	_, err := ParseCredential([]byte(`{"accessCode":"ABCD1234"}`))
	if err == nil {
		t.Fatal("expected error for missing serial")
	}
}

func TestParseCredential_Null(t *testing.T) {
	_, err := ParseCredential([]byte(`null`))
	if err == nil {
		t.Fatal("expected error for null credential")
	}
}
