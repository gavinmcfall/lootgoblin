/**
 * Unit tests — V2-005f-T_dcf12 StatusEventBus.
 *
 * Pure in-memory pub/sub. No DB, no network — just listener
 * registration / dispatch / unsubscribe semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createStatusEventBus,
  getDefaultStatusEventBus,
  resetDefaultStatusEventBus,
} from '../../src/forge/status/event-bus';
import type { StatusEvent } from '../../src/forge/status/types';

function makeEvent(kind: StatusEvent['kind'] = 'progress'): StatusEvent {
  return {
    kind,
    remoteJobRef: 'remote-1',
    progressPct: 42,
    rawPayload: {},
    occurredAt: new Date(),
  };
}

beforeEach(() => {
  resetDefaultStatusEventBus();
});

describe('createStatusEventBus', () => {
  it('emit with no listeners is a no-op', () => {
    const bus = createStatusEventBus();
    // Should not throw.
    expect(() => bus.emit('job-x', makeEvent())).not.toThrow();
  });

  it('subscribe + emit invokes the listener with the event', () => {
    const bus = createStatusEventBus();
    const received: StatusEvent[] = [];
    bus.subscribe('job-1', (e) => received.push(e));
    const evt = makeEvent('progress');
    bus.emit('job-1', evt);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(evt);
  });

  it('multiple listeners on the same dispatchJobId all receive the event', () => {
    const bus = createStatusEventBus();
    const a: StatusEvent[] = [];
    const b: StatusEvent[] = [];
    bus.subscribe('job-1', (e) => a.push(e));
    bus.subscribe('job-1', (e) => b.push(e));
    const evt = makeEvent();
    bus.emit('job-1', evt);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe removes the listener', () => {
    const bus = createStatusEventBus();
    const received: StatusEvent[] = [];
    const unsub = bus.subscribe('job-1', (e) => received.push(e));
    bus.emit('job-1', makeEvent());
    expect(received).toHaveLength(1);
    unsub();
    bus.emit('job-1', makeEvent());
    expect(received).toHaveLength(1); // still 1 — listener gone
  });

  it('a thrown listener does not block sibling listeners', () => {
    const bus = createStatusEventBus();
    const received: StatusEvent[] = [];
    bus.subscribe('job-1', () => {
      throw new Error('boom');
    });
    bus.subscribe('job-1', (e) => received.push(e));
    expect(() => bus.emit('job-1', makeEvent())).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it('emit to one dispatchJobId does not trigger listeners on a different one', () => {
    const bus = createStatusEventBus();
    const a: StatusEvent[] = [];
    const b: StatusEvent[] = [];
    bus.subscribe('job-1', (e) => a.push(e));
    bus.subscribe('job-2', (e) => b.push(e));
    bus.emit('job-1', makeEvent());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('a listener that unsubscribes itself during dispatch does not perturb sibling listeners', () => {
    const bus = createStatusEventBus();
    let unsubA: (() => void) | null = null;
    const aSeen: StatusEvent[] = [];
    const bSeen: StatusEvent[] = [];
    unsubA = bus.subscribe('job-1', (e) => {
      aSeen.push(e);
      // Snapshot semantics: removing during dispatch must not skip B.
      unsubA?.();
    });
    bus.subscribe('job-1', (e) => bSeen.push(e));
    bus.emit('job-1', makeEvent());
    expect(aSeen).toHaveLength(1);
    expect(bSeen).toHaveLength(1);
    // A is gone, only B fires now.
    bus.emit('job-1', makeEvent());
    expect(aSeen).toHaveLength(1);
    expect(bSeen).toHaveLength(2);
  });
});

describe('getDefaultStatusEventBus', () => {
  it('returns the same singleton across calls', () => {
    const a = getDefaultStatusEventBus();
    const b = getDefaultStatusEventBus();
    expect(a).toBe(b);
  });

  it('resetDefaultStatusEventBus drops the singleton', () => {
    const a = getDefaultStatusEventBus();
    resetDefaultStatusEventBus();
    const b = getDefaultStatusEventBus();
    expect(a).not.toBe(b);
  });
});
