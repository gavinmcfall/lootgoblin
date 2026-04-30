/**
 * Unit tests — V2-005d-b T_db1
 *
 * Bambu LAN per-model kind enumeration + capability table +
 * TargetCompatibilityMatrix interaction.
 *
 * Covers:
 *   1. All 13 BAMBU_LAN_KINDS appear in FORGE_PRINTER_KINDS.
 *   2. All 13 kinds have a BAMBU_MODEL_CAPABILITIES entry with sane shape.
 *   3. H2 series (representative: bambu_h2c) reports expansive AMS + chamber.
 *   4. A1 mini reports zero AMS units / slots.
 *   5. TargetCompatibilityMatrix verdict for `.gcode.3mf` is `native` for
 *      every Bambu LAN kind.
 *   6. Plain `gcode` is rejected (band !== 'native') for every Bambu LAN
 *      kind — Bambu LAN needs the Bambu Studio / Orca metadata wrapper.
 *   7. `isBambuLanKind` type guard correctness.
 */

import { describe, it, expect } from 'vitest';

import { FORGE_PRINTER_KINDS } from '../../src/db/schema.forge';
import {
  BAMBU_LAN_KINDS,
  BAMBU_MODEL_CAPABILITIES,
  isBambuLanKind,
  type BambuLanKind,
} from '../../src/forge/dispatch/bambu/types';
import { getCompatibility } from '../../src/forge/target-compatibility';

describe('BAMBU_LAN_KINDS ↔ FORGE_PRINTER_KINDS parity', () => {
  it('every BAMBU_LAN_KIND is present in FORGE_PRINTER_KINDS', () => {
    const printerKindSet = new Set<string>(FORGE_PRINTER_KINDS);
    for (const kind of BAMBU_LAN_KINDS) {
      expect(printerKindSet.has(kind), `${kind} missing from FORGE_PRINTER_KINDS`).toBe(true);
    }
  });
});

describe('BAMBU_MODEL_CAPABILITIES coverage + sanity', () => {
  it('every BAMBU_LAN_KIND has a capability record with non-negative AMS values', () => {
    for (const kind of BAMBU_LAN_KINDS) {
      const cap = BAMBU_MODEL_CAPABILITIES[kind];
      expect(cap, `${kind} missing capability record`).toBeDefined();
      expect(cap.maxAmsSlots, `${kind} maxAmsSlots negative`).toBeGreaterThanOrEqual(0);
      expect(cap.maxAmsUnits, `${kind} maxAmsUnits negative`).toBeGreaterThanOrEqual(0);
      expect(cap.bedSizeMm.x).toBeGreaterThan(0);
      expect(cap.bedSizeMm.y).toBeGreaterThan(0);
      expect(cap.bedSizeMm.z).toBeGreaterThan(0);
      expect(cap.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe('H2 series — expansive AMS + heated chamber', () => {
  it('bambu_h2c reports ≥4 AMS units, ≥16 slots, heated chamber, AMS HT support', () => {
    const cap = BAMBU_MODEL_CAPABILITIES.bambu_h2c;
    expect(cap.maxAmsUnits).toBeGreaterThanOrEqual(4);
    expect(cap.maxAmsSlots).toBeGreaterThanOrEqual(16);
    expect(cap.hasHeatedChamber).toBe(true);
    expect(cap.supportsAmsHt).toBe(true);
    expect(cap.isMultiFunction).toBe(true);
  });
});

describe('A1 mini — no AMS support', () => {
  it('bambu_a1_mini reports zero AMS units and slots', () => {
    const cap = BAMBU_MODEL_CAPABILITIES.bambu_a1_mini;
    expect(cap.maxAmsUnits).toBe(0);
    expect(cap.maxAmsSlots).toBe(0);
  });
});

describe('TargetCompatibilityMatrix — Bambu LAN .gcode.3mf is native', () => {
  it('every Bambu LAN kind accepts .gcode.3mf as native', () => {
    for (const kind of BAMBU_LAN_KINDS) {
      const verdict = getCompatibility('gcode.3mf', kind);
      expect(verdict.band, `${kind} should accept gcode.3mf natively`).toBe('native');
    }
  });

  it('leading-dot tolerance: ".gcode.3mf" also resolves to native', () => {
    const verdict = getCompatibility('.gcode.3mf', 'bambu_h2c');
    expect(verdict.band).toBe('native');
  });
});

describe('TargetCompatibilityMatrix — Bambu LAN rejects plain gcode', () => {
  it('plain gcode is NOT native for any Bambu LAN kind (require Bambu Studio metadata)', () => {
    for (const kind of BAMBU_LAN_KINDS) {
      const verdict = getCompatibility('gcode', kind);
      expect(verdict.band, `${kind} must not accept plain gcode`).not.toBe('native');
      expect(verdict.band).toBe('unsupported');
      expect(verdict.reason).toMatch(/gcode\.3mf/);
    }
  });
});

describe('isBambuLanKind type guard', () => {
  it('returns true for known Bambu kinds', () => {
    expect(isBambuLanKind('bambu_h2c')).toBe(true);
    expect(isBambuLanKind('bambu_a1_mini')).toBe(true);
    expect(isBambuLanKind('bambu_x1')).toBe(true);
  });

  it('returns false for non-Bambu / unknown kinds', () => {
    expect(isBambuLanKind('fdm_klipper')).toBe(false);
    expect(isBambuLanKind('fdm_bambu_lan')).toBe(false); // legacy generic kind, not per-model
    expect(isBambuLanKind('not_a_real_kind')).toBe(false);
    expect(isBambuLanKind('')).toBe(false);
  });

  it('narrows type when used as a guard', () => {
    const candidate: string = 'bambu_p1s';
    if (isBambuLanKind(candidate)) {
      // TS-check: capability lookup only valid because narrow happened.
      const cap = BAMBU_MODEL_CAPABILITIES[candidate satisfies BambuLanKind];
      expect(cap.displayName).toContain('P1S');
    } else {
      throw new Error('expected bambu_p1s to narrow');
    }
  });
});
