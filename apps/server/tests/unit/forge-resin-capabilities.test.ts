/**
 * Unit tests — V2-005d-c T_dc1
 *
 * Resin per-model kind enumeration (SDCP + ChituNetwork) + capability tables
 * + FDM Klipper expansion kinds + TargetCompatibilityMatrix interaction.
 *
 * Covers:
 *   1.  All 8 SDCP_KINDS appear in FORGE_PRINTER_KINDS.
 *   2.  All 7 CHITU_NETWORK_KINDS appear in FORGE_PRINTER_KINDS.
 *   3.  Both FDM Klipper expansion kinds appear in FORGE_PRINTER_KINDS.
 *   4.  Every SDCP kind has a SDCP_MODEL_CAPABILITIES entry with a sane shape.
 *   5.  Every ChituNetwork kind has a CHITU_NETWORK_MODEL_CAPABILITIES entry.
 *   6.  encryptedCtbRequired flag accuracy across both registries.
 *   7.  TargetCompatibilityMatrix verdict for `.ctb` is `native` for every
 *       SDCP per-model kind.
 *   8.  TargetCompatibilityMatrix verdict for `.ctb` is `native` for every
 *       ChituNetwork per-model kind.
 *   9.  Plain gcode is NOT native for any resin per-model kind.
 *   10. isSdcpKind + isChituNetworkKind type guards correctness.
 */

import { describe, it, expect } from 'vitest';

import { FORGE_PRINTER_KINDS } from '../../src/db/schema.forge';
import {
  SDCP_KINDS,
  SDCP_MODEL_CAPABILITIES,
  isSdcpKind,
} from '../../src/forge/dispatch/sdcp/types';
import {
  CHITU_NETWORK_KINDS,
  CHITU_NETWORK_MODEL_CAPABILITIES,
  isChituNetworkKind,
} from '../../src/forge/dispatch/chitu-network/types';
import { getCompatibility } from '../../src/forge/target-compatibility';

const FDM_KLIPPER_EXPANSION_KINDS = [
  'fdm_klipper_phrozen_arco',
  'fdm_klipper_elegoo_centauri_carbon',
] as const;

describe('SDCP_KINDS ↔ FORGE_PRINTER_KINDS parity', () => {
  it('every SDCP_KIND is present in FORGE_PRINTER_KINDS', () => {
    const printerKindSet = new Set<string>(FORGE_PRINTER_KINDS);
    for (const kind of SDCP_KINDS) {
      expect(printerKindSet.has(kind), `${kind} missing from FORGE_PRINTER_KINDS`).toBe(true);
    }
  });
});

describe('CHITU_NETWORK_KINDS ↔ FORGE_PRINTER_KINDS parity', () => {
  it('every CHITU_NETWORK_KIND is present in FORGE_PRINTER_KINDS', () => {
    const printerKindSet = new Set<string>(FORGE_PRINTER_KINDS);
    for (const kind of CHITU_NETWORK_KINDS) {
      expect(printerKindSet.has(kind), `${kind} missing from FORGE_PRINTER_KINDS`).toBe(true);
    }
  });
});

describe('FDM Klipper expansion kinds ↔ FORGE_PRINTER_KINDS parity', () => {
  it('both FDM Klipper expansion kinds are present in FORGE_PRINTER_KINDS', () => {
    const printerKindSet = new Set<string>(FORGE_PRINTER_KINDS);
    for (const kind of FDM_KLIPPER_EXPANSION_KINDS) {
      expect(printerKindSet.has(kind), `${kind} missing from FORGE_PRINTER_KINDS`).toBe(true);
    }
  });
});

describe('SDCP_MODEL_CAPABILITIES coverage + sanity', () => {
  it('every SDCP_KIND has a capability record with positive resolution + build volume', () => {
    for (const kind of SDCP_KINDS) {
      const cap = SDCP_MODEL_CAPABILITIES[kind];
      expect(cap, `${kind} missing capability record`).toBeDefined();
      expect(cap.xyResolutionUm, `${kind} xyResolutionUm non-positive`).toBeGreaterThan(0);
      expect(cap.buildVolumeMm.x).toBeGreaterThan(0);
      expect(cap.buildVolumeMm.y).toBeGreaterThan(0);
      expect(cap.buildVolumeMm.z).toBeGreaterThan(0);
      expect(cap.lcdResolution.width).toBeGreaterThan(0);
      expect(cap.lcdResolution.height).toBeGreaterThan(0);
      expect(cap.displayName.length).toBeGreaterThan(0);
      expect([1, 2]).toContain(cap.tier);
    }
  });
});

describe('CHITU_NETWORK_MODEL_CAPABILITIES coverage + sanity', () => {
  it('every CHITU_NETWORK_KIND has a capability record with positive resolution + build volume + accepted extensions', () => {
    for (const kind of CHITU_NETWORK_KINDS) {
      const cap = CHITU_NETWORK_MODEL_CAPABILITIES[kind];
      expect(cap, `${kind} missing capability record`).toBeDefined();
      expect(cap.xyResolutionUm, `${kind} xyResolutionUm non-positive`).toBeGreaterThan(0);
      expect(cap.buildVolumeMm.x).toBeGreaterThan(0);
      expect(cap.buildVolumeMm.y).toBeGreaterThan(0);
      expect(cap.buildVolumeMm.z).toBeGreaterThan(0);
      expect(cap.lcdResolution.width).toBeGreaterThan(0);
      expect(cap.lcdResolution.height).toBeGreaterThan(0);
      expect(cap.displayName.length).toBeGreaterThan(0);
      expect(cap.acceptedExtensions.length, `${kind} acceptedExtensions empty`).toBeGreaterThan(0);
      expect(cap.acceptedExtensions).toContain('.ctb');
      expect([1, 2]).toContain(cap.tier);
    }
  });
});

describe('encryptedCtbRequired flag accuracy', () => {
  it('all Elegoo SDCP kinds have encryptedCtbRequired=false (open boards)', () => {
    for (const kind of SDCP_KINDS) {
      expect(SDCP_MODEL_CAPABILITIES[kind].encryptedCtbRequired, `${kind} should be open`).toBe(false);
    }
  });

  it('Phrozen 8K family + Uniformation GKtwo + GKone require encrypted .ctb', () => {
    const lockedBoards = [
      'chitu_network_phrozen_sonic_mighty_8k',
      'chitu_network_phrozen_sonic_mega_8k',
      'chitu_network_phrozen_sonic_mini_8k',
      'chitu_network_uniformation_gktwo',
      'chitu_network_uniformation_gkone',
    ] as const;
    for (const kind of lockedBoards) {
      expect(CHITU_NETWORK_MODEL_CAPABILITIES[kind].encryptedCtbRequired, `${kind} should be locked`).toBe(true);
    }
  });

  it('legacy-firmware Elegoo (mars_legacy, saturn_legacy) does NOT require encrypted .ctb', () => {
    expect(CHITU_NETWORK_MODEL_CAPABILITIES.chitu_network_elegoo_mars_legacy.encryptedCtbRequired).toBe(false);
    expect(CHITU_NETWORK_MODEL_CAPABILITIES.chitu_network_elegoo_saturn_legacy.encryptedCtbRequired).toBe(false);
  });
});

describe('TargetCompatibilityMatrix — SDCP per-model kinds accept .ctb natively', () => {
  it('every SDCP kind accepts .ctb as native', () => {
    for (const kind of SDCP_KINDS) {
      const verdict = getCompatibility('ctb', kind);
      expect(verdict.band, `${kind} should accept ctb natively`).toBe('native');
    }
  });
});

describe('TargetCompatibilityMatrix — ChituNetwork per-model kinds accept .ctb natively', () => {
  it('every ChituNetwork kind accepts .ctb as native', () => {
    for (const kind of CHITU_NETWORK_KINDS) {
      const verdict = getCompatibility('ctb', kind);
      expect(verdict.band, `${kind} should accept ctb natively`).toBe('native');
    }
  });

  it('Uniformation GKtwo also accepts .jxs natively', () => {
    expect(getCompatibility('jxs', 'chitu_network_uniformation_gktwo').band).toBe('native');
  });

  it('legacy Elegoo kinds also accept .cbddlp natively', () => {
    expect(getCompatibility('cbddlp', 'chitu_network_elegoo_mars_legacy').band).toBe('native');
    expect(getCompatibility('cbddlp', 'chitu_network_elegoo_saturn_legacy').band).toBe('native');
  });
});

describe('TargetCompatibilityMatrix — resin per-model kinds reject plain gcode', () => {
  it('plain gcode is NOT native for any SDCP kind', () => {
    for (const kind of SDCP_KINDS) {
      const verdict = getCompatibility('gcode', kind);
      expect(verdict.band, `${kind} must not accept plain gcode`).not.toBe('native');
    }
  });

  it('plain gcode is NOT native for any ChituNetwork kind', () => {
    for (const kind of CHITU_NETWORK_KINDS) {
      const verdict = getCompatibility('gcode', kind);
      expect(verdict.band, `${kind} must not accept plain gcode`).not.toBe('native');
    }
  });
});

describe('TargetCompatibilityMatrix — FDM Klipper expansion kinds accept gcode natively', () => {
  it('both FDM Klipper expansion kinds accept gcode as native', () => {
    for (const kind of FDM_KLIPPER_EXPANSION_KINDS) {
      const verdict = getCompatibility('gcode', kind);
      expect(verdict.band, `${kind} should accept gcode natively`).toBe('native');
    }
  });
});

describe('isSdcpKind + isChituNetworkKind type guards', () => {
  it('isSdcpKind returns true for known SDCP kinds', () => {
    expect(isSdcpKind('sdcp_elegoo_saturn_4')).toBe(true);
    expect(isSdcpKind('sdcp_elegoo_mars_3')).toBe(true);
  });

  it('isSdcpKind returns false for non-SDCP kinds', () => {
    expect(isSdcpKind('chitu_network_phrozen_sonic_mighty_8k')).toBe(false);
    expect(isSdcpKind('resin_sdcp')).toBe(false); // legacy generic kind, not per-model
    expect(isSdcpKind('bambu_h2c')).toBe(false);
    expect(isSdcpKind('not_a_real_kind')).toBe(false);
    expect(isSdcpKind('')).toBe(false);
  });

  it('isChituNetworkKind returns true for known ChituNetwork kinds', () => {
    expect(isChituNetworkKind('chitu_network_uniformation_gktwo')).toBe(true);
    expect(isChituNetworkKind('chitu_network_elegoo_mars_legacy')).toBe(true);
  });

  it('isChituNetworkKind returns false for non-ChituNetwork kinds', () => {
    expect(isChituNetworkKind('sdcp_elegoo_saturn_4')).toBe(false);
    expect(isChituNetworkKind('resin_sdcp')).toBe(false);
    expect(isChituNetworkKind('not_a_real_kind')).toBe(false);
    expect(isChituNetworkKind('')).toBe(false);
  });
});
