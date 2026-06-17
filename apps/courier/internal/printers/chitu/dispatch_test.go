// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package chitu

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// bg returns a background context.
func bg() context.Context { return context.Background() }

// ---------------------------------------------------------------------------
// CTB gate — pure function tests
// ---------------------------------------------------------------------------

func TestIsEncryptedCTB(t *testing.T) {
	cases := []struct {
		name string
		head []byte
		want bool
	}{
		{"encrypted CTB v4", []byte{0x12, 0xfd, 0x90, 0xc1, 0x00}, true},
		{"plain CTB v4", []byte{0x12, 0xfd, 0x90, 0xc0, 0x00}, false},
		{"plain CTB v3", []byte{0x07, 0x00, 0x00, 0x00, 0x00}, false},
		{"random bytes", []byte{0xAA, 0xBB, 0xCC, 0xDD}, false},
		{"empty", []byte{}, false},
		{"too short (3 bytes)", []byte{0x12, 0xfd, 0x90}, false},
		{"exactly 4 bytes encrypted", []byte{0x12, 0xfd, 0x90, 0xc1}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsEncryptedCTB(tc.head)
			if got != tc.want {
				t.Errorf("IsEncryptedCTB(%x) = %v, want %v", tc.head, got, tc.want)
			}
		})
	}
}

func TestIsPlainCTB(t *testing.T) {
	cases := []struct {
		name string
		head []byte
		want bool
	}{
		{"plain CTB v4 (0xc0)", []byte{0x12, 0xfd, 0x90, 0xc0}, true},
		{"plain CTB v3 (0x07)", []byte{0x07, 0x00, 0x00, 0x00}, true},
		{"encrypted CTB v4 (0xc1)", []byte{0x12, 0xfd, 0x90, 0xc1}, false},
		{"jxs file", []byte{0x50, 0x4B, 0x03, 0x04}, false},
		{"empty", []byte{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsPlainCTB(tc.head)
			if got != tc.want {
				t.Errorf("IsPlainCTB(%x) = %v, want %v", tc.head, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Dispatch — file-format gate + encrypted-CTB gate
// ---------------------------------------------------------------------------

func writeFixture(t *testing.T, name string, data []byte) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// noDialFn panics if called — used to assert TCP is never reached.
func noDialFn(t *testing.T) func(string) (Conn, error) {
	return func(addr string) (Conn, error) {
		t.Fatalf("dial should not be called, got addr=%s", addr)
		return nil, nil
	}
}

// minimalCfg builds a minimal ConnectionConfig JSON.
func minimalCfgRaw(ip string) json.RawMessage {
	return json.RawMessage(`{"ip":"` + ip + `"}`)
}

func minimalCfg(ip string) ConnectionConfig {
	return ConnectionConfig{
		IP:             ip,
		Port:           3000,
		StartPrint:     true,
		StageTimeoutMs: 60_000,
	}
}

func TestDispatch_UnsupportedExtension(t *testing.T) {
	p := writeFixture(t, "model.gcode", []byte("G0 X0"))
	cfg := minimalCfg("127.0.0.1")
	result := Dispatch(bg(), cfg, "chitu_network_phrozen_sonic_mighty_8k", p, noDialFn(t), nil)
	if result.OK {
		t.Fatal("expected failure for unsupported extension")
	}
	if result.Reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", result.Reason)
	}
	if !strings.Contains(result.Details, ".ctb") {
		t.Errorf("details should mention .ctb, got %q", result.Details)
	}
}

func TestDispatch_EncryptedCTBGate_PlainCTBv4_Rejected(t *testing.T) {
	// Plain CTB v4 magic → rejected on locked-board kind.
	data := append([]byte{0x12, 0xfd, 0x90, 0xc0}, make([]byte, 16)...)
	p := writeFixture(t, "plain.ctb", data)
	cfg := minimalCfg("127.0.0.1")
	result := Dispatch(bg(), cfg, "chitu_network_phrozen_sonic_mighty_8k", p, noDialFn(t), nil)
	if result.OK {
		t.Fatal("expected rejection of plain CTB on locked-board kind")
	}
	if result.Reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", result.Reason)
	}
	if !strings.Contains(strings.ToLower(result.Details), "encrypted") {
		t.Errorf("details should mention encryption, got %q", result.Details)
	}
}

func TestDispatch_EncryptedCTBGate_PlainCTBv3_Rejected(t *testing.T) {
	// Plain CTB v3 magic → rejected on locked-board kind.
	data := append([]byte{0x07, 0x00, 0x00, 0x00}, make([]byte, 16)...)
	p := writeFixture(t, "v3.ctb", data)
	cfg := minimalCfg("127.0.0.1")
	result := Dispatch(bg(), cfg, "chitu_network_uniformation_gktwo", p, noDialFn(t), nil)
	if result.OK {
		t.Fatal("expected rejection")
	}
	if result.Reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", result.Reason)
	}
}

func TestDispatch_EncryptedCTBGate_EncryptedCTB_Passes(t *testing.T) {
	// Encrypted CTB magic → gate passes. TCP will fail (no real printer) →
	// expect an unreachable/network failure, NOT a rejected.
	data := append([]byte{0x12, 0xfd, 0x90, 0xc1}, make([]byte, 16)...)
	p := writeFixture(t, "enc.ctb", data)
	cfg := minimalCfg("127.0.0.1")

	// Inject a dial that fails with "connection refused" to short-circuit TCP.
	result := Dispatch(bg(), cfg, "chitu_network_phrozen_sonic_mighty_8k", p,
		func(_ string) (Conn, error) {
			return nil, &net.OpError{Op: "dial", Err: &net.AddrError{Err: "connection refused"}}
		}, nil)

	// The CTB gate should pass; the failure should be a TCP-level failure (not rejected).
	if result.Reason == "rejected" {
		t.Errorf("encrypted CTB should pass the gate; got rejected with details: %s", result.Details)
	}
}

func TestDispatch_EncryptedCTBGate_SkippedForOpenBoard(t *testing.T) {
	// Elegoo Mars (legacy) has encryptedCtbRequired=false.
	// Plain CTB should NOT be rejected by the gate.
	data := append([]byte{0x07, 0x00, 0x00, 0x00}, make([]byte, 16)...)
	p := writeFixture(t, "plain.ctb", data)
	cfg := minimalCfg("127.0.0.1")

	result := Dispatch(bg(), cfg, "chitu_network_elegoo_mars_legacy", p,
		func(_ string) (Conn, error) {
			return nil, &net.OpError{Op: "dial", Err: &net.AddrError{Err: "connection refused"}}
		}, nil)

	// Gate should be skipped; failure is TCP level (unreachable or similar).
	if result.Reason == "rejected" && strings.Contains(result.Details, "encrypted") {
		t.Error("open-board kind should skip the encrypted-CTB gate")
	}
}

func TestDispatch_FileNotFound(t *testing.T) {
	cfg := minimalCfg("127.0.0.1")
	result := Dispatch(bg(), cfg, "chitu_network_phrozen_sonic_mighty_8k",
		"/tmp/nonexistent_chitu_file.ctb", noDialFn(t), nil)
	if result.OK {
		t.Fatal("expected failure for missing file")
	}
	if result.Reason != "unknown" {
		t.Errorf("want reason=unknown, got %s", result.Reason)
	}
}

func TestDispatch_UnknownKind(t *testing.T) {
	cfg := minimalCfg("127.0.0.1")
	result := Dispatch(bg(), cfg, "chitu_network_unknown_printer",
		"/tmp/any.ctb", noDialFn(t), nil)
	if result.OK {
		t.Fatal("expected failure for unknown kind")
	}
	if result.Reason != "unknown" {
		t.Errorf("want reason=unknown, got %s", result.Reason)
	}
}

// ---------------------------------------------------------------------------
// ParseConnectionConfig defaults
// ---------------------------------------------------------------------------

func TestParseConnectionConfig_Defaults(t *testing.T) {
	cfg, err := ParseConnectionConfig([]byte(`{"ip":"192.168.1.10"}`))
	if err != nil {
		t.Fatalf("ParseConnectionConfig: %v", err)
	}
	if cfg.Port != 3000 {
		t.Errorf("default port: want 3000, got %d", cfg.Port)
	}
	if !cfg.StartPrint {
		t.Error("default startPrint: want true")
	}
	if cfg.StageTimeoutMs != 60_000 {
		t.Errorf("default stageTimeoutMs: want 60000, got %d", cfg.StageTimeoutMs)
	}
}

func TestParseConnectionConfig_MissingIP(t *testing.T) {
	_, err := ParseConnectionConfig([]byte(`{"port":3000}`))
	if err == nil {
		t.Fatal("expected error for missing ip")
	}
}

func TestParseConnectionConfig_Overrides(t *testing.T) {
	cfg, err := ParseConnectionConfig([]byte(
		`{"ip":"10.0.0.1","port":4000,"startPrint":false,"stageTimeoutMs":30000}`))
	if err != nil {
		t.Fatalf("ParseConnectionConfig: %v", err)
	}
	if cfg.Port != 4000 {
		t.Errorf("port: want 4000, got %d", cfg.Port)
	}
	if cfg.StartPrint {
		t.Error("startPrint: want false")
	}
	if cfg.StageTimeoutMs != 30_000 {
		t.Errorf("stageTimeoutMs: want 30000, got %d", cfg.StageTimeoutMs)
	}
}

// ---------------------------------------------------------------------------
// Adapter-level dispatch: kindAdapter dispatch path
// ---------------------------------------------------------------------------

func TestKindAdapter_Dispatch_BadConfig(t *testing.T) {
	a := kindAdapter{kind: "chitu_network_phrozen_sonic_mighty_8k"}
	outcome := a.Dispatch(bg(), []byte(`{}`), []byte(`{}`), "/tmp/x.ctb", nil)
	if outcome.OK {
		t.Fatal("expected failure for missing ip")
	}
	if outcome.Reason != "unknown" {
		t.Errorf("want reason=unknown, got %s", outcome.Reason)
	}
}

// ---------------------------------------------------------------------------
// Dispatch: cbddlp extension accepted on open-board kinds
// ---------------------------------------------------------------------------

func TestDispatch_CbddlpAccepted_ElegooMars(t *testing.T) {
	// .cbddlp is accepted by Elegoo Mars legacy.
	// Use a TCP dial that fails immediately to prove gate passes.
	data := make([]byte, 20)
	p := writeFixture(t, "test.cbddlp", data)
	cfg := minimalCfg("127.0.0.1")

	result := Dispatch(bg(), cfg, "chitu_network_elegoo_mars_legacy", p,
		func(_ string) (Conn, error) {
			return nil, &net.OpError{Op: "dial", Err: &net.AddrError{Err: "connection refused"}}
		}, nil)

	// Should NOT be rejected for extension or CTB gate.
	if result.Reason == "rejected" {
		t.Errorf("cbddlp should be accepted on Elegoo Mars legacy, got rejected: %s", result.Details)
	}
}
