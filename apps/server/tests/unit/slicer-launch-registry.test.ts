/**
 * V2-005e-T_e4 — Slicer launch URI registry unit tests.
 */

import { describe, it, expect } from 'vitest';

import {
  SLICER_KINDS,
  SLICER_LAUNCH_REGISTRY,
  isSlicerKind,
  renderLaunchUri,
} from '../../src/forge/slicers/launch-registry';

describe('SLICER_LAUNCH_REGISTRY (T_e4)', () => {
  it('all 11 slicer kinds defined', () => {
    expect(Object.keys(SLICER_LAUNCH_REGISTRY)).toHaveLength(11);
    for (const kind of SLICER_KINDS) {
      expect(SLICER_LAUNCH_REGISTRY[kind]).toBeDefined();
      expect(SLICER_LAUNCH_REGISTRY[kind].displayName).toBeTypeOf('string');
      expect(SLICER_LAUNCH_REGISTRY[kind].displayName.length).toBeGreaterThan(0);
    }
  });

  it('bambu_studio: scheme + template uses {url}', () => {
    const spec = SLICER_LAUNCH_REGISTRY.bambu_studio;
    expect(spec.uriScheme).toBe('bambu-connect');
    expect(spec.uriTemplate).toContain('{url}');
  });

  it('prusaslicer: null scheme + null template (download fallback)', () => {
    const spec = SLICER_LAUNCH_REGISTRY.prusaslicer;
    expect(spec.uriScheme).toBeNull();
    expect(spec.uriTemplate).toBeNull();
  });

  it('renderLaunchUri substitutes {url} placeholder', () => {
    const { uri, fallback } = renderLaunchUri(
      'bambu_studio',
      'https://lootgoblin.local/api/v1/loot/files/abc-123',
    );
    expect(uri).toBe(
      'bambu-connect://import-file?url=https://lootgoblin.local/api/v1/loot/files/abc-123',
    );
    expect(fallback).toBeNull();
  });

  it('renderLaunchUri returns fallback=download for slicers with no scheme', () => {
    const { uri, fallback } = renderLaunchUri('prusaslicer', 'https://example.com/file');
    expect(uri).toBe('');
    expect(fallback).toBe('download');
  });

  it('isSlicerKind narrows correctly', () => {
    expect(isSlicerKind('bambu_studio')).toBe(true);
    expect(isSlicerKind('orcaslicer')).toBe(true);
    expect(isSlicerKind('not-a-slicer')).toBe(false);
    expect(isSlicerKind('')).toBe(false);
    // Prototype probe — must NOT match Object.prototype keys.
    expect(isSlicerKind('toString')).toBe(false);
    expect(isSlicerKind('hasOwnProperty')).toBe(false);
  });
});
