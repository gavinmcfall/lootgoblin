/**
 * V2-005e-T_e3: Filename-heuristic unit tests.
 *
 * stripSlicerSuffixes is pure (no DB) — exhaustively check the suffix
 * patterns against the documented examples in the design doc. The DB-bound
 * heuristicMatchForSlice is exercised end-to-end by the integration tests.
 */

import { describe, it, expect } from 'vitest';

import {
  stripSlicerSuffixes,
  HEURISTIC_THRESHOLD,
  SUFFIX_PATTERNS,
} from '../../src/forge/slice-pairings/filename-heuristic';

describe('stripSlicerSuffixes', () => {
  it('drops PLA + layer-height suffix', () => {
    expect(stripSlicerSuffixes('cube_PLA_0.2mm.gcode')).toBe('cube');
  });

  it('drops multi-material + multi-color + print-time suffixes', () => {
    expect(stripSlicerSuffixes('cube_2color_4h32m_PLA-PETG.gcode')).toBe('cube');
  });

  it('drops AMS slot identifier', () => {
    expect(stripSlicerSuffixes('benchy_AMS3_PETG.gcode')).toBe('benchy');
  });

  it('drops parenthetical plate annotation', () => {
    expect(stripSlicerSuffixes('cube_(plate1).gcode.3mf')).toBe('cube');
  });

  it('drops _plate2 form', () => {
    expect(stripSlicerSuffixes('cube_plate2.bgcode')).toBe('cube');
  });

  it('lowercases + collapses repeated underscores + trims edges', () => {
    expect(stripSlicerSuffixes('Cube__Mesh_PLA_0.2mm.gcode')).toBe('cube_mesh');
  });

  it('keeps stems with no suffixes intact', () => {
    expect(stripSlicerSuffixes('keychain.stl')).toBe('keychain');
  });

  it('handles compound .gcode.3mf extension', () => {
    expect(stripSlicerSuffixes('plate_PLA.gcode.3mf')).toBe('plate');
  });
});

describe('SUFFIX_PATTERNS', () => {
  it('exposes a non-empty array', () => {
    expect(SUFFIX_PATTERNS.length).toBeGreaterThan(5);
  });
});

describe('HEURISTIC_THRESHOLD', () => {
  it('is set to 0.7 (per design)', () => {
    expect(HEURISTIC_THRESHOLD).toBe(0.7);
  });
});
