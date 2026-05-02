/**
 * Unit tests for V2-005f-T_dcf7 — SDCP status subscriber.
 *
 * Mocks the WebSocket via `WsFactory` and uses an injected timer rig so the
 * 30s keepalive ping cadence can be driven deterministically.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createSdcpSubscriber,
  mapSdcpStatus,
  buildSdcpEvent,
  type WsClientLike,
  type WsFactory,
} from '@/forge/status/subscribers/sdcp';
import type {
  StatusEvent,
  PrinterRecord,
  DecryptedCredential,
} from '@/forge/status';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeWs extends WsClientLike {
  __listeners: Record<string, Listener[]>;
  __sent: string[];
  __pings: number;
  __closed: boolean;
  fireOpen(): void;
  fireMessageRaw(data: unknown): void;
  fireMessageJson(json: unknown): void;
  fireClose(): void;
  fireError(err: Error): void;
}

function makeFakeWs(): FakeWs {
  const listeners: Record<string, Listener[]> = {};
  const ws: FakeWs = {
    __listeners: listeners,
    __sent: [],
    __pings: 0,
    __closed: false,
    readyState: 0,
    on(event: string, listener: Listener) {
      (listeners[event] ??= []).push(listener);
      return ws;
    },
    off(event: string, listener: Listener) {
      const arr = listeners[event];
      if (arr) {
        const idx = arr.indexOf(listener);
        if (idx >= 0) arr.splice(idx, 1);
      }
      return ws;
    },
    send(data: string, cb?: (err?: Error) => void) {
      ws.__sent.push(data);
      cb?.(undefined);
    },
    ping() {
      ws.__pings += 1;
    },
    close(_code?: number, _reason?: string) {
      ws.__closed = true;
    },
    fireOpen() {
      const arr = listeners.open ?? [];
      for (const fn of arr.slice()) fn();
    },
    fireMessageRaw(data: unknown) {
      const arr = listeners.message ?? [];
      for (const fn of arr.slice()) fn(data);
    },
    fireMessageJson(json: unknown) {
      const data = JSON.stringify(json);
      const arr = listeners.message ?? [];
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
  return ws;
}

interface FactoryRig {
  factory: WsFactory;
  calls: Array<{ url: string; headers?: Record<string, string> }>;
  sockets: FakeWs[];
  failNext(err: Error): void;
}

function makeFactoryRig(): FactoryRig {
  const calls: FactoryRig['calls'] = [];
  const sockets: FakeWs[] = [];
  let failure: Error | null = null;
  const factory: WsFactory = (url, options) => {
    calls.push({ url, headers: options?.headers });
    if (failure !== null) {
      const err = failure;
      failure = null;
      throw err;
    }
    const ws = makeFakeWs();
    sockets.push(ws);
    return ws;
  };
  return {
    factory,
    calls,
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
  /** Flush only the first matching timer (or any if no matcher). */
  flushOnce(matcher?: (t: { ms: number }) => boolean): boolean;
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
  };
}

const MAINBOARD_ID = 'AABBCCDDEEFF';
const STATUS_TOPIC = `sdcp/status/${MAINBOARD_ID}`;

function makePrinter(overrides: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    id: 'printer-sdcp-1',
    kind: 'sdcp_elegoo_saturn_4_ultra',
    connectionConfig: {
      ip: '192.168.1.66',
      mainboardId: MAINBOARD_ID,
      port: 3030,
      startPrint: true,
      startLayer: 0,
    },
    ...(overrides as Record<string, unknown>),
  } as unknown as PrinterRecord;
}

function statusMsg(printInfo: Record<string, unknown>): unknown {
  return {
    Topic: STATUS_TOPIC,
    Status: {
      PrintInfo: {
        ...printInfo,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

describe('V2-005f-T_dcf7 mapSdcpStatus', () => {
  it('maps every documented PrintInfo.Status value', () => {
    expect(mapSdcpStatus(0)).toBeNull();
    expect(mapSdcpStatus(1)).toBe('progress');
    expect(mapSdcpStatus(2)).toBe('completed');
    expect(mapSdcpStatus(3)).toBe('failed');
  });

  it('returns null for unknown / undefined values', () => {
    expect(mapSdcpStatus(undefined)).toBeNull();
    expect(mapSdcpStatus(99)).toBeNull();
    expect(mapSdcpStatus(-1)).toBeNull();
  });
});

describe('V2-005f-T_dcf7 buildSdcpEvent', () => {
  it('computes progressPct from layer ratio', () => {
    const ev = buildSdcpEvent(
      statusMsg({
        Status: 1,
        CurrentLayer: 250,
        TotalLayer: 1000,
        Filename: 'model.ctb',
        RemainTime: 3600,
      }) as Parameters<typeof buildSdcpEvent>[0],
      'progress',
      new Date(0),
    );
    expect(ev.kind).toBe('progress');
    expect(ev.layerNum).toBe(250);
    expect(ev.totalLayers).toBe(1000);
    expect(ev.progressPct).toBe(25);
    expect(ev.remainingMin).toBe(60);
    expect(ev.remoteJobRef).toBe('model.ctb');
    expect(ev.measuredConsumption).toBeUndefined();
  });

  it('falls back to TaskId when Filename absent', () => {
    const ev = buildSdcpEvent(
      statusMsg({ Status: 2, TaskId: 'task-uuid-123' }) as Parameters<
        typeof buildSdcpEvent
      >[0],
      'completed',
      new Date(0),
    );
    expect(ev.remoteJobRef).toBe('task-uuid-123');
  });

  it('omits progressPct when TotalLayer missing or zero', () => {
    const ev = buildSdcpEvent(
      statusMsg({ Status: 1, CurrentLayer: 5 }) as Parameters<typeof buildSdcpEvent>[0],
      'progress',
      new Date(0),
    );
    expect(ev.progressPct).toBeUndefined();
  });

  it('never sets measuredConsumption (resin printers do not track per-slot)', () => {
    const ev = buildSdcpEvent(
      statusMsg({ Status: 2, Filename: 'done.ctb' }) as Parameters<typeof buildSdcpEvent>[0],
      'completed',
      new Date(0),
    );
    expect(ev.measuredConsumption).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Subscriber lifecycle tests
// ---------------------------------------------------------------------------

describe('V2-005f-T_dcf7 createSdcpSubscriber', () => {
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
    const sub = createSdcpSubscriber({
      printerKind: 'sdcp_elegoo_saturn_4_ultra',
      wsFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10, 20, 30],
      keepaliveIntervalMs: 30_000,
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

  it('connects WS to ws://<ip>:3030/websocket', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    expect(factoryRig.calls).toHaveLength(1);
    expect(factoryRig.calls[0]!.url).toBe('ws://192.168.1.66:3030/websocket');
    await sub.stop();
  });

  it('sends Cmd 0 subscribe with topic + MainboardID after ws.open', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    expect(ws.__sent).toHaveLength(1);
    const sub0 = JSON.parse(ws.__sent[0]!) as Record<string, unknown>;
    expect(sub0.Topic).toBe(STATUS_TOPIC);
    const data = sub0.Data as Record<string, unknown>;
    expect(data.Cmd).toBe(0);
    expect(data.MainboardID).toBe(MAINBOARD_ID);
    expect(typeof data.RequestID).toBe('string');
    expect(typeof data.TimeStamp).toBe('number');
    expect(data.From).toBe(0);
    await sub.stop();
  });

  it('first valid status message marks subscriber connected', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    expect(sub.isConnected()).toBe(false);
    ws.fireMessageJson(statusMsg({ Status: 0 }));
    expect(sub.isConnected()).toBe(true);
    // Status=0 → no event surfaced
    expect(events).toHaveLength(0);
    await sub.stop();
  });

  it('emits progress on Status=1 with layer + percent + remaining', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    ws.fireMessageJson(
      statusMsg({
        Status: 1,
        CurrentLayer: 42,
        TotalLayer: 1000,
        Filename: 'demo.ctb',
        RemainTime: 1800,
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('progress');
    expect(events[0]!.layerNum).toBe(42);
    expect(events[0]!.totalLayers).toBe(1000);
    expect(events[0]!.progressPct).toBe(4); // round(42/1000*100)
    expect(events[0]!.remainingMin).toBe(30);
    expect(events[0]!.remoteJobRef).toBe('demo.ctb');
    expect(events[0]!.measuredConsumption).toBeUndefined();
    await sub.stop();
  });

  it('emits completed on Status=2', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    ws.fireMessageJson(
      statusMsg({ Status: 2, Filename: 'done.ctb', CurrentLayer: 1000, TotalLayer: 1000 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('completed');
    expect(events[0]!.measuredConsumption).toBeUndefined();
    await sub.stop();
  });

  it('emits failed on Status=3', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    ws.fireMessageJson(statusMsg({ Status: 3, Filename: 'oops.ctb' }));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('failed');
    expect(events[0]!.measuredConsumption).toBeUndefined();
    await sub.stop();
  });

  it('Status=0 emits no protocol event (only marks connected)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    ws.fireMessageJson(statusMsg({ Status: 0 }));
    expect(events).toHaveLength(0);
    expect(sub.isConnected()).toBe(true);
    await sub.stop();
  });

  it('ignores messages on foreign topics', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    ws.fireMessageJson({
      Topic: 'sdcp/status/SOMETHING_ELSE',
      Status: { PrintInfo: { Status: 2, Filename: 'x.ctb' } },
    });
    ws.fireMessageJson({ Topic: 'sdcp/attributes/AABBCCDDEEFF', Status: {} });
    expect(events).toHaveLength(0);
    expect(sub.isConnected()).toBe(false);
    await sub.stop();
  });

  it('tolerates malformed JSON without emitting events', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    ws.fireMessageRaw('not json{{{');
    ws.fireMessageRaw('');
    ws.fireMessageRaw(null);
    ws.fireMessageRaw(undefined);
    expect(events).toHaveLength(0);
    expect(sub.isConnected()).toBe(false);
    await sub.stop();
  });

  it('arms keepalive ping every 30s', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    expect(ws.__pings).toBe(0);

    // First keepalive timer should have been scheduled at 30_000ms
    const keep = timerRig.pending.find((t) => t.ms === 30_000);
    expect(keep).toBeDefined();

    // Fire it → ping #1, and a fresh 30_000ms timer should be re-armed
    timerRig.flushOnce((t) => t.ms === 30_000);
    expect(ws.__pings).toBe(1);
    expect(timerRig.pending.find((t) => t.ms === 30_000)).toBeDefined();

    // Fire next → ping #2
    timerRig.flushOnce((t) => t.ms === 30_000);
    expect(ws.__pings).toBe(2);
    expect(timerRig.pending.find((t) => t.ms === 30_000)).toBeDefined();

    await sub.stop();
  });

  it('stop() cancels keepalive (no further pings)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    timerRig.flushOnce((t) => t.ms === 30_000);
    expect(ws.__pings).toBe(1);
    await sub.stop();
    // No 30_000ms timer should remain after stop
    expect(timerRig.pending.find((t) => t.ms === 30_000)).toBeUndefined();
  });

  it('close stops keepalive (no further pings without re-arm)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    expect(timerRig.pending.find((t) => t.ms === 30_000)).toBeDefined();
    ws.fireClose();
    expect(timerRig.pending.find((t) => t.ms === 30_000)).toBeUndefined();
    await sub.stop();
  });

  it('schedules reconnect on close (delegated to base)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    ws.fireMessageJson(statusMsg({ Status: 0 }));
    expect(sub.isConnected()).toBe(true);

    ws.fireClose();
    expect(sub.isConnected()).toBe(false);
    // A reconnect timer (10ms from our schedule override) should be queued
    expect(timerRig.pending.find((t) => t.ms === 10)).toBeDefined();

    timerRig.flushOnce((t) => t.ms === 10);
    await new Promise((r) => setTimeout(r, 0));
    expect(factoryRig.calls.length).toBeGreaterThanOrEqual(2);

    await sub.stop();
  });

  it('emits unreachable on initial factory throw', async () => {
    factoryRig.failNext(new Error('ECONNREFUSED'));
    const sub = createSdcpSubscriber({
      printerKind: 'sdcp_elegoo_saturn_4_ultra',
      wsFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10],
      keepaliveIntervalMs: 30_000,
    });
    await sub.start(makePrinter(), null, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('unreachable');
    await sub.stop();
  });

  it('passes printerKind through to the StatusSubscriber', async () => {
    const sub = createSdcpSubscriber({
      printerKind: 'sdcp_elegoo_mars_5',
      wsFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10],
      keepaliveIntervalMs: 30_000,
    });
    expect(sub.printerKind).toBe('sdcp_elegoo_mars_5');
    expect(sub.protocol).toBe('sdcp');
  });

  it('does not reconnect after stop()', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    factoryRig.sockets[0]!.fireOpen();
    await sub.stop();
    factoryRig.sockets[0]!.fireClose();
    // No reconnect timer queued after stop
    expect(timerRig.pending.find((t) => t.ms === 10)).toBeUndefined();
    expect(factoryRig.calls).toHaveLength(1);
  });

  it('stop() is idempotent', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    factoryRig.sockets[0]!.fireOpen();
    await sub.stop();
    await expect(sub.stop()).resolves.toBeUndefined();
    expect(sub.isConnected()).toBe(false);
  });

  it('measuredConsumption is always undefined across all kinds', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();
    ws.fireMessageJson(statusMsg({ Status: 1, CurrentLayer: 1, TotalLayer: 10, Filename: 'a' }));
    ws.fireMessageJson(statusMsg({ Status: 2, Filename: 'b' }));
    ws.fireMessageJson(statusMsg({ Status: 3, Filename: 'c' }));
    expect(events.map((e) => e.kind)).toEqual(['progress', 'completed', 'failed']);
    expect(events.every((e) => e.measuredConsumption === undefined)).toBe(true);
    await sub.stop();
  });
});
