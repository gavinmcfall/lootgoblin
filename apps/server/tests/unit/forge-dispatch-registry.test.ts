import { describe, it, expect, beforeEach } from 'vitest';

import {
  createDispatchHandlerRegistry,
  getDefaultRegistry,
} from '@/forge/dispatch/registry';
import type { DispatchHandler } from '@/forge/dispatch/handler';

const fakeHandler = (kind: string): DispatchHandler => ({
  kind,
  dispatch: async () => ({ kind: 'success', remoteFilename: 'fake.gcode' }),
});

describe('DispatchHandlerRegistry', () => {
  beforeEach(() => {
    getDefaultRegistry().clear();
  });

  it('register then get returns the handler', () => {
    const reg = createDispatchHandlerRegistry();
    const h = fakeHandler('fdm_klipper');
    reg.register(h);
    expect(reg.get('fdm_klipper')).toBe(h);
  });

  it('get returns null for unregistered kind', () => {
    const reg = createDispatchHandlerRegistry();
    expect(reg.get('not-a-kind')).toBeNull();
  });

  it('re-registering replaces the prior handler', () => {
    const reg = createDispatchHandlerRegistry();
    const h1 = fakeHandler('fdm_klipper');
    const h2 = fakeHandler('fdm_klipper');
    reg.register(h1);
    reg.register(h2);
    expect(reg.get('fdm_klipper')).toBe(h2);
  });

  it('list returns all registered handlers', () => {
    const reg = createDispatchHandlerRegistry();
    reg.register(fakeHandler('a'));
    reg.register(fakeHandler('b'));
    reg.register(fakeHandler('c'));
    expect(reg.list().map((h) => h.kind).sort()).toEqual(['a', 'b', 'c']);
  });

  it('getDefaultRegistry is a process-level singleton', () => {
    const r1 = getDefaultRegistry();
    const r2 = getDefaultRegistry();
    expect(r1).toBe(r2);
    r1.register(fakeHandler('singleton-test'));
    expect(r2.get('singleton-test')).not.toBeNull();
  });

  it('clear() empties the registry', () => {
    const reg = createDispatchHandlerRegistry();
    reg.register(fakeHandler('x'));
    expect(reg.list()).toHaveLength(1);
    reg.clear();
    expect(reg.list()).toHaveLength(0);
  });
});
