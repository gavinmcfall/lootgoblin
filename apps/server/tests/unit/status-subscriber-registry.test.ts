/**
 * Unit tests — StatusSubscriberRegistry — V2-005f-T_dcf9.
 *
 * Mirrors the V2-005d-a `forge-dispatch-registry` shape — the registry is a
 * thin Map-backed structure, but the small contract (register-replaces-warns,
 * insertion-order list, has/get/clear, process singleton) needs to stay
 * stable since `forge-status-worker` and the production wiring both lean on
 * those exact semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createSubscriberRegistry,
  getDefaultSubscriberRegistry,
  resetDefaultSubscriberRegistry,
  type StatusSubscriberFactory,
} from '@/forge/status/registry';
import type { StatusSubscriber } from '@/forge/status/types';

function fakeSubscriber(): StatusSubscriber {
  return {
    protocol: 'moonraker',
    printerKind: 'fdm_klipper',
    async start() {},
    async stop() {},
    isConnected() {
      return false;
    },
  };
}

function fakeFactory(): StatusSubscriberFactory {
  return { create: () => fakeSubscriber() };
}

describe('StatusSubscriberRegistry — V2-005f-T_dcf9', () => {
  beforeEach(() => {
    resetDefaultSubscriberRegistry();
  });

  it('register then get returns the factory', () => {
    const reg = createSubscriberRegistry();
    const f = fakeFactory();
    reg.register('fdm_klipper', f);
    expect(reg.get('fdm_klipper')).toBe(f);
  });

  it('get returns undefined and has returns false for unregistered kind', () => {
    const reg = createSubscriberRegistry();
    expect(reg.get('not-a-kind')).toBeUndefined();
    expect(reg.has('not-a-kind')).toBe(false);
  });

  it('has returns true once a kind is registered', () => {
    const reg = createSubscriberRegistry();
    reg.register('bambu_x1c', fakeFactory());
    expect(reg.has('bambu_x1c')).toBe(true);
  });

  it('re-registering replaces the prior factory', () => {
    const reg = createSubscriberRegistry();
    const f1 = fakeFactory();
    const f2 = fakeFactory();
    reg.register('fdm_klipper', f1);
    reg.register('fdm_klipper', f2);
    expect(reg.get('fdm_klipper')).toBe(f2);
    // Single entry — duplicate kind doesn't double-list.
    expect(reg.list()).toEqual(['fdm_klipper']);
  });

  it('list returns kinds in insertion order', () => {
    const reg = createSubscriberRegistry();
    reg.register('a', fakeFactory());
    reg.register('b', fakeFactory());
    reg.register('c', fakeFactory());
    expect(reg.list()).toEqual(['a', 'b', 'c']);
  });

  it('clear() empties the registry', () => {
    const reg = createSubscriberRegistry();
    reg.register('x', fakeFactory());
    expect(reg.list()).toHaveLength(1);
    reg.clear();
    expect(reg.list()).toHaveLength(0);
    expect(reg.has('x')).toBe(false);
  });

  it('getDefaultSubscriberRegistry is a process-level singleton', () => {
    const r1 = getDefaultSubscriberRegistry();
    const r2 = getDefaultSubscriberRegistry();
    expect(r1).toBe(r2);
    r1.register('singleton-test', fakeFactory());
    expect(r2.has('singleton-test')).toBe(true);
  });

  it('resetDefaultSubscriberRegistry forces a fresh singleton on next access', () => {
    const r1 = getDefaultSubscriberRegistry();
    r1.register('keep-me', fakeFactory());
    resetDefaultSubscriberRegistry();
    const r2 = getDefaultSubscriberRegistry();
    expect(r2).not.toBe(r1);
    expect(r2.has('keep-me')).toBe(false);
  });
});
