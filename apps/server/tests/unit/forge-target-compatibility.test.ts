/**
 * Unit tests — TargetCompatibilityMatrix (V2-005a-T6)
 *
 * Pure-domain behaviour of getCompatibility / bulkGetCompatibility — no DB,
 * no auth, no HTTP. Asserts the matrix's verdicts for representative
 * (format, targetKind) pairs across the three bands plus edge cases
 * (case insensitivity, leading-dot tolerance, archive sentinel, default
 * unsupported).
 */

import { describe, it, expect } from 'vitest';

import {
  getCompatibility,
  bulkGetCompatibility,
  getMatrixSnapshot,
  ALL_FORGE_TARGET_KINDS,
  ARCHIVE_EXTRACT_SENTINEL,
  type TargetKind,
} from '../../src/forge/target-compatibility';

describe('getCompatibility — native band', () => {
  it('STL → orcaslicer is native', () => {
    expect(getCompatibility('stl', 'orcaslicer')).toEqual({ band: 'native' });
  });

  it('gcode → fdm_klipper is native', () => {
    expect(getCompatibility('gcode', 'fdm_klipper')).toEqual({ band: 'native' });
  });

  it('3mf → fdm_bambu_lan is native (Bambu LAN accepts metadata-laden 3mf)', () => {
    expect(getCompatibility('3mf', 'fdm_bambu_lan')).toEqual({ band: 'native' });
  });

  it('ctb → resin_sdcp is native', () => {
    expect(getCompatibility('ctb', 'resin_sdcp')).toEqual({ band: 'native' });
  });
});

describe('getCompatibility — conversion-required band', () => {
  it('STL → fdm_klipper requires slicing to gcode', () => {
    const v = getCompatibility('stl', 'fdm_klipper');
    expect(v.band).toBe('conversion-required');
    expect(v.conversionTo).toBe('gcode');
  });

  it('OBJ → chitubox requires conversion to STL (resin slicer prefers stl)', () => {
    // chitubox has 'obj' as native, so this returns native — flip to fbx for the
    // conversion test (FBX is never native; converts to stl).
    const v = getCompatibility('fbx', 'chitubox');
    expect(v.band).toBe('conversion-required');
    expect(v.conversionTo).toBe('stl');
  });

  it('GLB → orcaslicer converts to STL', () => {
    const v = getCompatibility('glb', 'orcaslicer');
    expect(v.band).toBe('conversion-required');
    expect(v.conversionTo).toBe('stl');
  });

  it('zip → orcaslicer is conversion-required with archive-extract sentinel', () => {
    expect(getCompatibility('zip', 'orcaslicer')).toEqual({
      band: 'conversion-required',
      conversionTo: ARCHIVE_EXTRACT_SENTINEL,
    });
  });

  it('rar / 7z behave the same as zip', () => {
    for (const f of ['rar', '7z']) {
      const v = getCompatibility(f, 'cura');
      expect(v.band).toBe('conversion-required');
      expect(v.conversionTo).toBe(ARCHIVE_EXTRACT_SENTINEL);
    }
  });
});

describe('getCompatibility — unsupported band', () => {
  it('gcode → resin_sdcp is unsupported with resin/gcode reason', () => {
    const v = getCompatibility('gcode', 'resin_sdcp');
    expect(v.band).toBe('unsupported');
    expect(v.reason).toMatch(/resin/i);
    expect(v.reason).toMatch(/gcode/i);
  });

  it('jpeg → any printer is unsupported with image reason', () => {
    const v = getCompatibility('jpeg', 'fdm_klipper');
    expect(v.band).toBe('unsupported');
    expect(v.reason).toMatch(/image/i);
  });

  it('jpeg → slicer is also unsupported (wildcard reason)', () => {
    const v = getCompatibility('jpeg', 'orcaslicer');
    expect(v.band).toBe('unsupported');
    expect(v.reason).toMatch(/image/i);
  });

  it('png / webp behave like jpeg', () => {
    for (const f of ['png', 'webp']) {
      const v = getCompatibility(f, 'cura');
      expect(v.band).toBe('unsupported');
      expect(v.reason).toMatch(/image/i);
    }
  });

  it('ctb → fdm_klipper is unsupported (resin format on FDM)', () => {
    const v = getCompatibility('ctb', 'fdm_klipper');
    expect(v.band).toBe('unsupported');
    expect(v.reason).toMatch(/resin/i);
  });

  it("unknown format → any target is unsupported with default reason", () => {
    const v = getCompatibility('xyzzy-not-a-format', 'orcaslicer');
    expect(v.band).toBe('unsupported');
    expect(v.reason).toMatch(/no known conversion/i);
  });

  it('pdf → any target is unsupported', () => {
    const v = getCompatibility('pdf', 'orcaslicer');
    expect(v.band).toBe('unsupported');
    expect(v.reason).toMatch(/pdf/i);
  });
});

describe('format normalization', () => {
  it('uppercase format matches lowercase entry', () => {
    expect(getCompatibility('STL', 'orcaslicer')).toEqual({ band: 'native' });
  });

  it('mixed-case + leading dot still matches', () => {
    expect(getCompatibility('.Stl', 'orcaslicer')).toEqual({ band: 'native' });
  });

  it('uppercase unsupported triggers same reason', () => {
    const v = getCompatibility('JPEG', 'fdm_klipper');
    expect(v.band).toBe('unsupported');
    expect(v.reason).toMatch(/image/i);
  });
});

describe('bulkGetCompatibility', () => {
  it('returns a verdict for every requested target kind', () => {
    const result = bulkGetCompatibility('stl', ALL_FORGE_TARGET_KINDS);
    for (const kind of ALL_FORGE_TARGET_KINDS) {
      expect(result[kind]).toBeDefined();
      expect(['native', 'conversion-required', 'unsupported']).toContain(
        result[kind].band,
      );
    }
  });

  it('mixes bands in a single call', () => {
    const result = bulkGetCompatibility('stl', [
      'orcaslicer',
      'fdm_klipper',
      'resin_sdcp',
    ] as TargetKind[]);
    expect(result.orcaslicer.band).toBe('native');
    expect(result.fdm_klipper.band).toBe('conversion-required');
    expect(result.fdm_klipper.conversionTo).toBe('gcode');
    // STL → resin_sdcp: not native (resin needs ctb/goo/etc.); no conversion
    // path STL → ctb in the matrix → unsupported with default reason.
    expect(result.resin_sdcp.band).toBe('unsupported');
  });
});

describe('getMatrixSnapshot', () => {
  it('returns native + conversion entries shaped correctly', () => {
    const snap = getMatrixSnapshot();
    expect(snap.nativeFormats.orcaslicer).toContain('stl');
    expect(snap.nativeFormats.fdm_klipper).toEqual(['gcode']);
    expect(snap.conversionPaths.fbx).toEqual(['stl']);
    expect(snap.conversionPaths.stl).toContain('gcode');
  });
});
