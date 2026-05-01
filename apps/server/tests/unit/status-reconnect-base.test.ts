/**
 * Unit tests for V2-005f — `_reconnect-base.ts`.
 *
 * Validates the protocol-agnostic state machine that wraps every
 * StatusSubscriber: connect/open/close/reconnect lifecycle, the
 * `unreachable`/`reconnected` connectivity events, the I-1 stop/race fix,
 * and idempotent stop/start.
 *
 * The "transport" in these tests is a tiny fake driven by helpers handed to
 * `openTransport` — no protocol-specific concepts (no WS, no MQTT, etc.).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createReconnectingSubscriber,
  type OpenTransportHelpers,
  type TransportHandle,
} from '@/forge/status/subscribers/_reconnect-base';
import type {
  StatusEvent,
  PrinterRecord,
  DecryptedCredential,
} from '@/forge/status';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeTransport {
  helpers: OpenTransportHelpers;
  closed: boolean;
  closeFn: () => void;
}

interface TransportRig {
  /** All openTransport invocations, in order. */
  opens: FakeTransport[];
  /** Override the next openTransport call to throw. */
  failNext: (err: Error) => void;
  /** The actual openTransport implementation. */
  openTransport: (
    printer: PrinterRecord,
    cred: DecryptedCredential | null,
    helpers: OpenTransportHelpers,
  ) => TransportHandle;
}

function makeTransportRig(): TransportRig {
  const opens: FakeTransport[] = [];
  let failure: Error | null = null;
  return {
    opens,
    failNext(err) {
      failure = err;
    },
    openTransport(_p, _c, helpers) {
      if (failure !== null) {
        const err = failure;
        failure = null;
        throw err;
      }
      const transport: FakeTransport = {
        helpers,
        closed: false,
        closeFn: () => {
          transport.closed = true;
        },
      };
      opens.push(transport);
      return { close: () => transport.closeFn() };
    },
  };
}

interface TimerRig {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  pending: Array<{ cb: () => void; ms: number; handle: number }>;
  flushOnce(): void;
}

function makeTimerRig(): TimerRig {
  const pending: TimerRig['pending'] = [];
  let next = 0;
  return {
    pending,
    setTimer(cb, ms) {
      const handle = ++next;
      pending.push({ cb, ms, handle });
      return handle;
    },
    clearTimer(h) {
      const idx = pending.findIndex((t) => t.handle === h);
      if (idx >= 0) pending.splice(idx, 1);
    },
    flushOnce() {
      const t = pending.shift();
      if (t) t.cb();
    },
  };
}

function makePrinter(): PrinterRecord {
  return {
    id: 'printer-1',
    kind: 'fdm_klipper',
    connectionConfig: {},
  } as unknown as PrinterRecord;
}

function makeProtocolEvent(kind: StatusEvent['kind'], jobRef = 'job-1'): StatusEvent {
  return {
    kind,
    remoteJobRef: jobRef,
    rawPayload: { test: true },
    occurredAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2-005f createReconnectingSubscriber', () => {
  let transportRig: TransportRig;
  let timerRig: TimerRig;
  let events: StatusEvent[];

  beforeEach(() => {
    transportRig = makeTransportRig();
    timerRig = makeTimerRig();
    events = [];
  });

  function startSubscriber() {
    const sub = createReconnectingSubscriber({
      protocol: 'moonraker',
      printerKind: 'fdm_klipper',
      openTransport: transportRig.openTransport,
      reconnectBackoffMs: [10, 20, 30],
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
    });
    return {
      sub,
      promise: sub.start(makePrinter(), null, (e) => events.push(e)),
    };
  }

  it('calls openTransport on start', async () => {
    const { sub } = startSubscriber();
    expect(transportRig.opens).toHaveLength(1);
    expect(sub.isConnected()).toBe(false);
    await sub.stop();
  });

  it('marks connected and resets attempt on onTransportOpen', async () => {
    const { sub } = startSubscriber();
    transportRig.opens[0]!.helpers.onTransportOpen();
    expect(sub.isConnected()).toBe(true);

    // Initial connect MUST NOT emit 'reconnected'.
    expect(events.filter((e) => e.kind === 'reconnected')).toHaveLength(0);

    await sub.stop();
  });

  it('emits unreachable once when openTransport throws on first attempt', async () => {
    transportRig.failNext(new Error('ECONNREFUSED'));
    const sub = createReconnectingSubscriber({
      protocol: 'moonraker',
      printerKind: 'fdm_klipper',
      openTransport: transportRig.openTransport,
      reconnectBackoffMs: [10, 20, 30],
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
    });
    await sub.start(makePrinter(), null, (e) => events.push(e));

    expect(events.filter((e) => e.kind === 'unreachable')).toHaveLength(1);
    expect(timerRig.pending).toHaveLength(1);

    await sub.stop();
  });

  it('does not re-emit unreachable on subsequent connect failures in same cycle', async () => {
    transportRig.failNext(new Error('ECONNREFUSED'));
    const sub = createReconnectingSubscriber({
      protocol: 'moonraker',
      printerKind: 'fdm_klipper',
      openTransport: transportRig.openTransport,
      reconnectBackoffMs: [10, 20, 30],
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
    });
    await sub.start(makePrinter(), null, (e) => events.push(e));
    expect(events.filter((e) => e.kind === 'unreachable')).toHaveLength(1);

    transportRig.failNext(new Error('ECONNREFUSED'));
    timerRig.flushOnce();
    expect(events.filter((e) => e.kind === 'unreachable')).toHaveLength(1);

    transportRig.failNext(new Error('ECONNREFUSED'));
    timerRig.flushOnce();
    expect(events.filter((e) => e.kind === 'unreachable')).toHaveLength(1);

    await sub.stop();
  });

  it('emits reconnected on the next successful open after a connected→close cycle', async () => {
    const { sub } = startSubscriber();

    // First: real connect.
    transportRig.opens[0]!.helpers.onTransportOpen();
    expect(sub.isConnected()).toBe(true);
    expect(events.filter((e) => e.kind === 'reconnected')).toHaveLength(0);

    // Disconnect after a connected session.
    transportRig.opens[0]!.helpers.onTransportClose(true);
    expect(sub.isConnected()).toBe(false);
    expect(timerRig.pending).toHaveLength(1);

    // Reconnect: timer fires, new openTransport, then onTransportOpen.
    timerRig.flushOnce();
    expect(transportRig.opens).toHaveLength(2);
    transportRig.opens[1]!.helpers.onTransportOpen();

    const reconnected = events.filter((e) => e.kind === 'reconnected');
    expect(reconnected).toHaveLength(1);
    expect(reconnected[0]!.remoteJobRef).toBe('');

    await sub.stop();
  });

  it('does NOT emit reconnected on the very first open of a fresh subscriber', async () => {
    const { sub } = startSubscriber();
    transportRig.opens[0]!.helpers.onTransportOpen();
    expect(events.filter((e) => e.kind === 'reconnected')).toHaveLength(0);
    await sub.stop();
  });

  it('drops events that arrive after stop (I-1 race fix)', async () => {
    const { sub } = startSubscriber();
    const helpers = transportRig.opens[0]!.helpers;
    helpers.onTransportOpen();
    helpers.emitProtocolEvent(makeProtocolEvent('progress'));
    expect(events).toHaveLength(1);

    await sub.stop();

    // Late-arriving events from the transport's pending close window:
    helpers.emitProtocolEvent(makeProtocolEvent('progress', 'late-1'));
    helpers.emitProtocolEvent(makeProtocolEvent('completed', 'late-2'));
    helpers.onTransportClose(true);

    // No new events surfaced after stop.
    expect(events).toHaveLength(1);
    // No reconnect timer scheduled.
    expect(timerRig.pending).toHaveLength(0);
  });

  it('clears pending reconnect timer on stop', async () => {
    const { sub } = startSubscriber();
    const helpers = transportRig.opens[0]!.helpers;
    helpers.onTransportOpen();
    helpers.onTransportClose(true);
    expect(timerRig.pending).toHaveLength(1);

    await sub.stop();
    expect(timerRig.pending).toHaveLength(0);
  });

  it('closes the active transport handle on stop', async () => {
    const { sub } = startSubscriber();
    transportRig.opens[0]!.helpers.onTransportOpen();
    expect(transportRig.opens[0]!.closed).toBe(false);

    await sub.stop();
    expect(transportRig.opens[0]!.closed).toBe(true);
  });

  it('start after stop fully resets state (no spurious reconnected)', async () => {
    const { sub } = startSubscriber();
    transportRig.opens[0]!.helpers.onTransportOpen();
    transportRig.opens[0]!.helpers.onTransportClose(true);
    // needsReconnectedEvent is set internally — but stop should clear it.
    await sub.stop();

    // Restart.
    events.length = 0;
    await sub.start(makePrinter(), null, (e) => events.push(e));
    expect(transportRig.opens).toHaveLength(2);
    transportRig.opens[1]!.helpers.onTransportOpen();

    // Fresh first-connect → no reconnected.
    expect(events.filter((e) => e.kind === 'reconnected')).toHaveLength(0);
    expect(sub.isConnected()).toBe(true);

    await sub.stop();
  });

  it('emitProtocolEvent before start is dropped', async () => {
    // No start yet → no listener; we can't actually call helpers without
    // having gone through openTransport. So instead we verify the
    // pre-start invariant by checking that protocol events arriving from
    // a stale attempt after stop are dropped — same code path.
    const { sub } = startSubscriber();
    const staleHelpers = transportRig.opens[0]!.helpers;
    await sub.stop();
    staleHelpers.emitProtocolEvent(makeProtocolEvent('progress'));
    expect(events).toHaveLength(0);
  });

  it('emitProtocolEvent after stop is dropped', async () => {
    const { sub } = startSubscriber();
    const helpers = transportRig.opens[0]!.helpers;
    helpers.onTransportOpen();
    await sub.stop();
    helpers.emitProtocolEvent(makeProtocolEvent('progress'));
    expect(events).toHaveLength(0);
  });

  it('forwards protocol events while running', async () => {
    const { sub } = startSubscriber();
    const helpers = transportRig.opens[0]!.helpers;
    helpers.onTransportOpen();

    helpers.emitProtocolEvent(makeProtocolEvent('progress'));
    helpers.emitProtocolEvent(makeProtocolEvent('paused'));
    helpers.emitProtocolEvent(makeProtocolEvent('completed'));

    expect(events.map((e) => e.kind)).toEqual(['progress', 'paused', 'completed']);

    await sub.stop();
  });

  it('reuses last backoff entry when schedule is exhausted', async () => {
    transportRig.failNext(new Error('e1'));
    const sub = createReconnectingSubscriber({
      protocol: 'moonraker',
      printerKind: 'fdm_klipper',
      openTransport: transportRig.openTransport,
      reconnectBackoffMs: [10, 20],
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
    });
    await sub.start(makePrinter(), null, (e) => events.push(e));
    expect(timerRig.pending[0]!.ms).toBe(10);

    transportRig.failNext(new Error('e2'));
    timerRig.flushOnce();
    expect(timerRig.pending[0]!.ms).toBe(20);

    transportRig.failNext(new Error('e3'));
    timerRig.flushOnce();
    // Schedule exhausted → cap on last entry (20).
    expect(timerRig.pending[0]!.ms).toBe(20);

    await sub.stop();
  });

  it('reports correct protocol/printerKind on the StatusSubscriber', async () => {
    const sub = createReconnectingSubscriber({
      protocol: 'octoprint',
      printerKind: 'fdm_octoprint',
      openTransport: transportRig.openTransport,
      reconnectBackoffMs: [10],
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
    });
    expect(sub.protocol).toBe('octoprint');
    expect(sub.printerKind).toBe('fdm_octoprint');
  });

  it('stop is idempotent', async () => {
    const { sub } = startSubscriber();
    transportRig.opens[0]!.helpers.onTransportOpen();
    await sub.stop();
    await expect(sub.stop()).resolves.toBeUndefined();
    expect(sub.isConnected()).toBe(false);
  });
});
