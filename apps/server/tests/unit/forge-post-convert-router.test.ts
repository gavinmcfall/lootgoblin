/**
 * Unit tests — Post-convert router — V2-005c-T_c9.
 *
 * Pure module, no DB. All calls inject a stubbed `resolvePrinterKind`.
 */

import { describe, it, expect } from 'vitest';

import {
  routePostConvert,
  type PostConvertRouteInput,
} from '../../src/forge/slicer/post-convert-router';

function makeResolver(map: Record<string, string | null>) {
  return (printerId: string): string | null => {
    return printerId in map ? map[printerId]! : null;
  };
}

const baseInput: Omit<PostConvertRouteInput, 'resolvePrinterKind'> = {
  targetKind: 'slicer',
  targetId: 'noop',
  currentFormat: 'stl',
};

describe('routePostConvert', () => {
  it('1. slicer target → claimable regardless of format', async () => {
    const decision = await routePostConvert({
      ...baseInput,
      targetKind: 'slicer',
      targetId: 'slicer-123',
      currentFormat: 'stl',
      resolvePrinterKind: makeResolver({}),
    });
    expect(decision.next).toBe('claimable');
    if (decision.next === 'claimable') {
      expect(decision.reason).toBe('slicer-target-just-opens-file');
    }
  });

  it('2. printer target with gcode → claimable (already-gcode)', async () => {
    const decision = await routePostConvert({
      targetKind: 'printer',
      targetId: 'p-1',
      currentFormat: 'gcode',
      resolvePrinterKind: makeResolver({ 'p-1': 'fdm_klipper' }),
    });
    expect(decision.next).toBe('claimable');
    if (decision.next === 'claimable') {
      expect(decision.reason).toBe('already-gcode');
    }
  });

  it('3. printer target with bgcode → claimable (already-gcode)', async () => {
    const decision = await routePostConvert({
      targetKind: 'printer',
      targetId: 'p-1',
      currentFormat: 'bgcode',
      resolvePrinterKind: makeResolver({ 'p-1': 'fdm_klipper' }),
    });
    expect(decision.next).toBe('claimable');
    if (decision.next === 'claimable') {
      expect(decision.reason).toBe('already-gcode');
    }
  });

  it('4. printer target with stl → slicing (needs-gcode-from-mesh)', async () => {
    const decision = await routePostConvert({
      targetKind: 'printer',
      targetId: 'p-1',
      currentFormat: 'stl',
      resolvePrinterKind: makeResolver({ 'p-1': 'fdm_klipper' }),
    });
    expect(decision.next).toBe('slicing');
    if (decision.next === 'slicing') {
      expect(decision.reason).toBe('needs-gcode-from-mesh');
    }
  });

  it('4b. printer target with 3mf on Bambu LAN → claimable (native-format)', async () => {
    const decision = await routePostConvert({
      targetKind: 'printer',
      targetId: 'p-bambu',
      currentFormat: '3mf',
      resolvePrinterKind: makeResolver({ 'p-bambu': 'fdm_bambu_lan' }),
    });
    expect(decision.next).toBe('claimable');
    if (decision.next === 'claimable') {
      expect(decision.reason).toBe('native-format');
    }
  });

  it('5. unknown printer (resolver returns null) → failed/unknown-printer', async () => {
    const decision = await routePostConvert({
      targetKind: 'printer',
      targetId: 'p-missing',
      currentFormat: 'stl',
      resolvePrinterKind: makeResolver({}),
    });
    expect(decision.next).toBe('failed');
    if (decision.next === 'failed') {
      expect(decision.reason).toBe('unknown-printer');
    }
  });

  it('6. printer target with png (incompatible) → failed/incompatible-target', async () => {
    const decision = await routePostConvert({
      targetKind: 'printer',
      targetId: 'p-1',
      currentFormat: 'png',
      resolvePrinterKind: makeResolver({ 'p-1': 'fdm_klipper' }),
    });
    expect(decision.next).toBe('failed');
    if (decision.next === 'failed') {
      expect(decision.reason).toBe('incompatible-target');
      expect(decision.details).toContain('png');
    }
  });

  it('7. async resolver works (returns Promise<string|null>)', async () => {
    const decision = await routePostConvert({
      targetKind: 'printer',
      targetId: 'p-1',
      currentFormat: 'stl',
      resolvePrinterKind: async (id) =>
        id === 'p-1' ? 'fdm_klipper' : null,
    });
    expect(decision.next).toBe('slicing');
  });
});
