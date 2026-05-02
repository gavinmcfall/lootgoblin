/**
 * Unit tests for V2-005f-T_dcf8 — ChituNetwork adaptive TCP poller.
 *
 * Mocks the TCP socket via an injected `TcpSocketFactory` and uses an
 * injected timer rig so the polling cadence state machine can be exercised
 * deterministically.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createChituNetworkSubscriber,
  parseM27Reply,
  nextState,
  CHITU_POLL_INTERVALS_MS,
  CHITU_NEAR_COMPLETION_THRESHOLD_PCT,
  CHITU_JUST_FINISHED_DURATION_MS,
  type ChituPollingState,
} from '@/forge/status/subscribers/chitu-network';
import type { TcpSocketLike, TcpSocketFactory } from '@/forge/dispatch/chitu-network/commander';
import type {
  StatusEvent,
  PrinterRecord,
  DecryptedCredential,
} from '@/forge/status';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeSocket extends TcpSocketLike {
  __listeners: Record<string, Listener[]>;
  __sent: string[];
  __connectedTo: { port: number; host: string } | null;
  __ended: boolean;
  __destroyed: boolean;
  fireConnect(): void;
  fireData(data: Buffer | string): void;
  fireClose(): void;
  fireError(err: Error): void;
}

function makeFakeSocket(): FakeSocket {
  const listeners: Record<string, Listener[]> = {};
  let connectCb: (() => void) | null = null;
  const sock: FakeSocket = {
    __listeners: listeners,
    __sent: [],
    __connectedTo: null,
    __ended: false,
    __destroyed: false,
    connect(port: number, host: string, cb?: () => void) {
      sock.__connectedTo = { port, host };
      connectCb = cb ?? null;
    },
    write(data: Buffer | string, cb?: (err?: Error) => void) {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      sock.__sent.push(text);
      cb?.(undefined);
    },
    end() {
      sock.__ended = true;
    },
    destroy() {
      sock.__destroyed = true;
    },
    on(event: string, listener: Listener) {
      (listeners[event] ??= []).push(listener);
    },
    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => {
        const arr = listeners[event] ?? [];
        const idx = arr.indexOf(wrapped);
        if (idx >= 0) arr.splice(idx, 1);
        listener(...args);
      };
      (listeners[event] ??= []).push(wrapped);
    },
    fireConnect() {
      if (connectCb) {
        const cb = connectCb;
        connectCb = null;
        cb();
      }
      const arr = listeners.connect ?? [];
      for (const fn of arr.slice()) fn();
    },
    fireData(data: Buffer | string) {
      const arr = listeners.data ?? [];
      for (const fn of arr.slice()) fn(data);
    },
    fireClose() {
      const arr = listeners.close ?? [];
      for (const fn of arr.slice()) fn();
    },
    fireError(err: Error) {
      const arr = listeners.error ?? [];
      for (const fn of arr.slice()) fn(err);
    },
  };
  return sock;
}

interface FactoryRig {
  factory: TcpSocketFactory;
  sockets: FakeSocket[];
  failNext(err: Error): void;
}

function makeFactoryRig(): FactoryRig {
  const sockets: FakeSocket[] = [];
  let failure: Error | null = null;
  const factory: TcpSocketFactory = () => {
    if (failure !== null) {
      const err = failure;
      failure = null;
      throw err;
    }
    const sock = makeFakeSocket();
    sockets.push(sock);
    return sock;
  };
  return {
    factory,
    sockets,
    failNext(err) {
      failure = err;
    },
  };
}

interface TimerRig {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  pending: Array<{ cb: () => void; ms: number; handle: number }>;
  flushOnce(matcher?: (t: { ms: number }) => boolean): boolean;
  flushAll(matcher?: (t: { ms: number }) => boolean): number;
}

function makeTimerRig(): TimerRig {
  const pending: TimerRig['pending'] = [];
  let next = 0;
  return {
    pending,
    setTimer(cb: () => void, ms: number) {
      const handle = ++next;
      pending.push({ cb, ms, handle });
      return handle;
    },
    clearTimer(h: unknown) {
      const idx = pending.findIndex((t) => t.handle === h);
      if (idx >= 0) pending.splice(idx, 1);
    },
    flushOnce(matcher) {
      const idx = matcher ? pending.findIndex(matcher) : 0;
      if (idx < 0 || idx >= pending.length) return false;
      const [t] = pending.splice(idx, 1);
      t!.cb();
      return true;
    },
    flushAll(matcher) {
      let count = 0;
      while (true) {
        const idx = matcher ? pending.findIndex(matcher) : 0;
        if (idx < 0 || pending.length === 0) break;
        if (!matcher && pending.length === 0) break;
        const [t] = pending.splice(idx, 1);
        t!.cb();
        count += 1;
      }
      return count;
    },
  };
}

function makePrinter(overrides: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    id: 'printer-chitu-1',
    kind: 'chitu_network_phrozen_sonic_mighty_8k',
    connectionConfig: {
      ip: '192.168.1.42',
      port: 3000,
      startPrint: true,
      stageTimeoutMs: 60_000,
    },
    ...(overrides as Record<string, unknown>),
  } as unknown as PrinterRecord;
}

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

describe('V2-005f-T_dcf8 parseM27Reply', () => {
  it('parses `Print: X/Y` mid-print', () => {
    expect(parseM27Reply('Print: 12345/100000')).toEqual({
      bytesPrinted: 12345,
      totalBytes: 100000,
    });
    expect(parseM27Reply('Print: 0/100000\r\n')).toEqual({
      bytesPrinted: 0,
      totalBytes: 100000,
    });
    // Whitespace tolerance.
    expect(parseM27Reply('  Print:  92000 / 100000  ')).toEqual({
      bytesPrinted: 92000,
      totalBytes: 100000,
    });
  });

  it('detects `Not currently printing`', () => {
    expect(parseM27Reply('Not currently printing')).toBe('not-printing');
    expect(parseM27Reply('not currently printing\r\n')).toBe('not-printing');
    expect(parseM27Reply('  Not Currently Printing  ')).toBe('not-printing');
  });

  it('returns null for malformed / unrelated lines', () => {
    expect(parseM27Reply('ok')).toBeNull();
    expect(parseM27Reply('')).toBeNull();
    expect(parseM27Reply('echo: blah')).toBeNull();
    expect(parseM27Reply('Print: not-a-number/100')).toBeNull();
  });
});

describe('V2-005f-T_dcf8 nextState', () => {
  it('IDLE → PRINTING when M27 reports bytes_printed > 0', () => {
    expect(nextState('IDLE', { bytesPrinted: 100, totalBytes: 1000 })).toBe('PRINTING');
  });

  it('IDLE → IDLE when bytes_printed === 0', () => {
    expect(nextState('IDLE', { bytesPrinted: 0, totalBytes: 1000 })).toBe('IDLE');
  });

  it('PRINTING → NEAR_COMPLETION at threshold', () => {
    expect(nextState('PRINTING', { bytesPrinted: 91, totalBytes: 100 })).toBe('NEAR_COMPLETION');
    expect(nextState('PRINTING', { bytesPrinted: 90, totalBytes: 100 })).toBe('NEAR_COMPLETION');
    expect(nextState('PRINTING', { bytesPrinted: 89, totalBytes: 100 })).toBe('PRINTING');
  });

  it('PRINTING → JUST_FINISHED on `not-printing`', () => {
    expect(nextState('PRINTING', 'not-printing')).toBe('JUST_FINISHED');
  });

  it('NEAR_COMPLETION → JUST_FINISHED on `not-printing`', () => {
    expect(nextState('NEAR_COMPLETION', 'not-printing')).toBe('JUST_FINISHED');
  });

  it('IDLE → IDLE on `not-printing`', () => {
    expect(nextState('IDLE', 'not-printing')).toBe('IDLE');
  });

  it('JUST_FINISHED stays put on `not-printing` (timer governs exit)', () => {
    expect(nextState('JUST_FINISHED', 'not-printing')).toBe('JUST_FINISHED');
  });

  it('null reply preserves state', () => {
    const states: ChituPollingState[] = ['IDLE', 'PRINTING', 'NEAR_COMPLETION', 'JUST_FINISHED'];
    for (const s of states) expect(nextState(s, null)).toBe(s);
  });

  it('totalBytes === 0 preserves state (avoid divide-by-zero)', () => {
    expect(nextState('PRINTING', { bytesPrinted: 0, totalBytes: 0 })).toBe('PRINTING');
  });

  it('threshold constant matches the documented 90%', () => {
    expect(CHITU_NEAR_COMPLETION_THRESHOLD_PCT).toBe(90);
  });

  it('cadence constants match the spec', () => {
    expect(CHITU_POLL_INTERVALS_MS.IDLE).toBe(60_000);
    expect(CHITU_POLL_INTERVALS_MS.PRINTING).toBe(10_000);
    expect(CHITU_POLL_INTERVALS_MS.NEAR_COMPLETION).toBe(2_000);
    expect(CHITU_POLL_INTERVALS_MS.JUST_FINISHED).toBe(30_000);
    expect(CHITU_JUST_FINISHED_DURATION_MS).toBe(5 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Subscriber lifecycle tests
// ---------------------------------------------------------------------------

describe('V2-005f-T_dcf8 createChituNetworkSubscriber', () => {
  let factoryRig: FactoryRig;
  let timerRig: TimerRig;
  let events: StatusEvent[];

  beforeEach(() => {
    factoryRig = makeFactoryRig();
    timerRig = makeTimerRig();
    events = [];
  });

  function startSubscriber(
    opts: { printer?: PrinterRecord; credential?: DecryptedCredential | null } = {},
  ) {
    const sub = createChituNetworkSubscriber({
      printerKind: 'chitu_network_phrozen_sonic_mighty_8k',
      tcpFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10, 20, 30],
      m27TimeoutMs: 5_000,
    });
    return {
      sub,
      promise: sub.start(
        opts.printer ?? makePrinter(),
        opts.credential === undefined ? null : opts.credential,
        (e) => events.push(e),
      ),
    };
  }

  /**
   * Drive a complete poll cycle: flush the active poll timer, deliver an M27
   * reply line, then return. The subscriber writes `M27\n`, awaits a single
   * `\n`-terminated line, and re-arms the next poll.
   */
  async function deliverM27Reply(replyLine: string, ms: number): Promise<void> {
    expect(timerRig.flushOnce((t) => t.ms === ms)).toBe(true);
    // The poll callback is async; let its microtasks drain so sendM27 has
    // installed pendingM27 before we deliver data.
    await Promise.resolve();
    await Promise.resolve();
    const sock = factoryRig.sockets[0]!;
    sock.fireData(replyLine.endsWith('\n') ? replyLine : replyLine + '\n');
    // Allow sendM27's resolution + state update microtasks to settle.
    await Promise.resolve();
    await Promise.resolve();
  }

  it('connects TCP to <ip>:3000 on start', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    expect(factoryRig.sockets).toHaveLength(1);
    const sock = factoryRig.sockets[0]!;
    expect(sock.__connectedTo).toEqual({ port: 3000, host: '192.168.1.42' });
    sock.fireConnect();
    expect(sub.isConnected()).toBe(true);
    await sub.stop();
  });

  it('first poll fires after 60s IDLE interval and writes `M27\\n`', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();

    // Poll timer at IDLE cadence should be queued.
    expect(timerRig.pending.find((t) => t.ms === 60_000)).toBeDefined();
    expect(sock.__sent).toHaveLength(0);

    timerRig.flushOnce((t) => t.ms === 60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(sock.__sent).toEqual(['M27\n']);

    await sub.stop();
  });

  it('notifyPrinting() forces IDLE → PRINTING, next poll at 10s', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();

    // Initial IDLE poll queued at 60s.
    expect(timerRig.pending.find((t) => t.ms === 60_000)).toBeDefined();

    sub.notifyPrinting();
    // 60s timer cleared, 10s timer (PRINTING) queued instead.
    expect(timerRig.pending.find((t) => t.ms === 60_000)).toBeUndefined();
    expect(timerRig.pending.find((t) => t.ms === 10_000)).toBeDefined();

    await sub.stop();
  });

  it('PRINTING → NEAR_COMPLETION emits progress + retunes to 2s', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();
    sub.notifyPrinting();

    // Drive a PRINTING poll → reply 92% → state should become NEAR_COMPLETION.
    await deliverM27Reply('Print: 92000/100000', 10_000);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('progress');
    expect(events[0]!.progressPct).toBe(92);
    expect(events[0]!.measuredConsumption).toBeUndefined();
    // Next poll should be queued at NEAR_COMPLETION cadence (2s).
    expect(timerRig.pending.find((t) => t.ms === 2_000)).toBeDefined();

    await sub.stop();
  });

  it('PRINTING progress event fires with byte-ratio progressPct', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();
    sub.notifyPrinting();

    await deliverM27Reply('Print: 25000/100000', 10_000);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('progress');
    expect(events[0]!.progressPct).toBe(25);
    expect(events[0]!.layerNum).toBeUndefined();
    expect(events[0]!.totalLayers).toBeUndefined();
    expect(events[0]!.remainingMin).toBeUndefined();
    expect(events[0]!.measuredConsumption).toBeUndefined();
    // Still PRINTING — next poll at 10s.
    expect(timerRig.pending.find((t) => t.ms === 10_000)).toBeDefined();

    await sub.stop();
  });

  it('NEAR_COMPLETION → JUST_FINISHED emits completed + retunes to 30s', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();
    sub.notifyPrinting();

    // Reach NEAR_COMPLETION first.
    await deliverM27Reply('Print: 95000/100000', 10_000);
    expect(events.at(-1)!.kind).toBe('progress');

    // Now `Not currently printing` → JUST_FINISHED + completed event.
    await deliverM27Reply('Not currently printing', 2_000);
    const completed = events.at(-1)!;
    expect(completed.kind).toBe('completed');
    expect(completed.progressPct).toBe(100);
    expect(completed.measuredConsumption).toBeUndefined();

    // JUST_FINISHED cadence poll queued.
    expect(timerRig.pending.find((t) => t.ms === 30_000)).toBeDefined();
    // 5-min exit timer scheduled.
    expect(
      timerRig.pending.find((t) => t.ms === CHITU_JUST_FINISHED_DURATION_MS),
    ).toBeDefined();

    await sub.stop();
  });

  it('PRINTING → JUST_FINISHED also emits completed', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();
    sub.notifyPrinting();

    // Skip NEAR — go straight from PRINTING to not-printing.
    await deliverM27Reply('Print: 50000/100000', 10_000);
    expect(events.at(-1)!.kind).toBe('progress');
    await deliverM27Reply('Not currently printing', 10_000);
    expect(events.at(-1)!.kind).toBe('completed');
    expect(events.at(-1)!.measuredConsumption).toBeUndefined();

    await sub.stop();
  });

  it('JUST_FINISHED → IDLE after 5-min timer, polls return to 60s', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();
    sub.notifyPrinting();

    await deliverM27Reply('Print: 50000/100000', 10_000);
    await deliverM27Reply('Not currently printing', 10_000);
    expect(events.at(-1)!.kind).toBe('completed');

    // Fire the 5-min exit timer.
    expect(timerRig.flushOnce((t) => t.ms === CHITU_JUST_FINISHED_DURATION_MS)).toBe(true);
    // The exit handler clears the JUST_FINISHED 30s poll and reschedules at IDLE.
    expect(timerRig.pending.find((t) => t.ms === 60_000)).toBeDefined();

    await sub.stop();
  });

  it('IDLE + `Not currently printing` stays IDLE, no event', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();

    await deliverM27Reply('Not currently printing', 60_000);
    expect(events).toHaveLength(0);
    expect(timerRig.pending.find((t) => t.ms === 60_000)).toBeDefined();

    await sub.stop();
  });

  it('IDLE picks up an externally-started print on M27 `Print: X/Y`', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();

    // No notifyPrinting — printer was started by the operator at the panel.
    await deliverM27Reply('Print: 5000/100000', 60_000);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('progress');
    expect(events[0]!.progressPct).toBe(5);
    // Now in PRINTING state — next poll at 10s.
    expect(timerRig.pending.find((t) => t.ms === 10_000)).toBeDefined();

    await sub.stop();
  });

  it('malformed M27 reply tolerated — no crash, state preserved', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();

    await deliverM27Reply('totally garbage line', 60_000);
    expect(events).toHaveLength(0);
    // Still IDLE — next poll at 60s again.
    expect(timerRig.pending.find((t) => t.ms === 60_000)).toBeDefined();

    await sub.stop();
  });

  it('measuredConsumption never populated across all event kinds', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();
    sub.notifyPrinting();

    await deliverM27Reply('Print: 25000/100000', 10_000); // progress
    await deliverM27Reply('Print: 95000/100000', 10_000); // progress (NEAR)
    await deliverM27Reply('Not currently printing', 2_000); // completed

    expect(events.map((e) => e.kind)).toEqual(['progress', 'progress', 'completed']);
    expect(events.every((e) => e.measuredConsumption === undefined)).toBe(true);

    await sub.stop();
  });

  it('disconnect is delegated to reconnect-base (close → reconnect timer queued)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();
    expect(sub.isConnected()).toBe(true);

    sock.fireClose();
    expect(sub.isConnected()).toBe(false);
    // First reconnect backoff (we overrode to 10ms).
    expect(timerRig.pending.find((t) => t.ms === 10)).toBeDefined();

    await sub.stop();
  });

  it('stop() clears poll + just-finished timers', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();
    sub.notifyPrinting();
    await deliverM27Reply('Print: 50000/100000', 10_000);
    await deliverM27Reply('Not currently printing', 10_000);
    // Both 30_000 (poll) + 5-min (exit) should be queued.
    expect(timerRig.pending.find((t) => t.ms === 30_000)).toBeDefined();
    expect(
      timerRig.pending.find((t) => t.ms === CHITU_JUST_FINISHED_DURATION_MS),
    ).toBeDefined();

    await sub.stop();
    // Both gone.
    expect(timerRig.pending.find((t) => t.ms === 30_000)).toBeUndefined();
    expect(
      timerRig.pending.find((t) => t.ms === CHITU_JUST_FINISHED_DURATION_MS),
    ).toBeUndefined();
  });

  it('stop() is idempotent', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    factoryRig.sockets[0]!.fireConnect();
    await sub.stop();
    await expect(sub.stop()).resolves.toBeUndefined();
    expect(sub.isConnected()).toBe(false);
  });

  it('emits unreachable on initial factory throw', async () => {
    factoryRig.failNext(new Error('ECONNREFUSED'));
    const sub = createChituNetworkSubscriber({
      printerKind: 'chitu_network_phrozen_sonic_mighty_8k',
      tcpFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10],
    });
    await sub.start(makePrinter(), null, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('unreachable');
    await sub.stop();
  });

  it('passes printerKind + protocol through to the StatusSubscriber', () => {
    const sub = createChituNetworkSubscriber({
      printerKind: 'chitu_network_uniformation_gktwo',
      tcpFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
    });
    expect(sub.printerKind).toBe('chitu_network_uniformation_gktwo');
    expect(sub.protocol).toBe('chitu_network');
    expect(typeof sub.notifyPrinting).toBe('function');
  });

  it('notifyPrinting() is a no-op once already PRINTING', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const sock = factoryRig.sockets[0]!;
    sock.fireConnect();
    sub.notifyPrinting();
    // Now in PRINTING. Calling again should not re-arm.
    const before = timerRig.pending.find((t) => t.ms === 10_000);
    sub.notifyPrinting();
    const after = timerRig.pending.find((t) => t.ms === 10_000);
    // Same single timer, not duplicated.
    expect(after).toBeDefined();
    expect(after).toBe(before);
    expect(timerRig.pending.filter((t) => t.ms === 10_000)).toHaveLength(1);

    await sub.stop();
  });

  it('does not reconnect after stop()', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    factoryRig.sockets[0]!.fireConnect();
    await sub.stop();
    factoryRig.sockets[0]!.fireClose();
    expect(timerRig.pending.find((t) => t.ms === 10)).toBeUndefined();
    expect(factoryRig.sockets).toHaveLength(1);
  });
});
