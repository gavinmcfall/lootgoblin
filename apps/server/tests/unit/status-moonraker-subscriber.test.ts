/**
 * Unit tests for V2-005f-T_dcf4 — Moonraker status subscriber.
 *
 * Injects a fake `WsClientLike` factory and a manual timer scheduler so
 * each scenario drives reconnect + JSON-RPC handling deterministically.
 *
 * V2-005f-CF-5b T_b1: Moonraker filament_used capture + mm→grams conversion.
 * The conversion module is vi.mock'd so tests stay pure-unit with no DB.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// V2-005f-CF-5b T_b1: mock the conversion module so Moonraker tests stay
// unit-only (no real DB seeding required). The real module is tested in
// cf-5b-conversion.test.ts.
vi.mock('@/forge/status/divergence/conversion', () => ({
  convertFilamentMmToGrams: vi.fn().mockResolvedValue({ grams: 2.98, densitySource: 'fallback' }),
}));

import {
  createMoonrakerSubscriber,
  type WsClientLike,
  type WsFactory,
} from '@/forge/status/subscribers/moonraker';
import type {
  StatusEvent,
  PrinterRecord,
  DecryptedCredential,
} from '@/forge/status';
import { convertFilamentMmToGrams } from '@/forge/status/divergence/conversion';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeWs extends WsClientLike {
  __listeners: Record<string, Listener[]>;
  __sent: string[];
  __closed: boolean;
  __closeCode?: number;
  __closeReason?: string;
  fireOpen(): void;
  fireMessage(json: unknown): void;
  fireClose(code?: number, reason?: string): void;
  fireError(err: Error): void;
}

function makeFakeWs(): FakeWs {
  const listeners: Record<string, Listener[]> = {};
  const ws: FakeWs = {
    __listeners: listeners,
    __sent: [],
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
    close(code?: number, reason?: string) {
      ws.__closed = true;
      ws.__closeCode = code;
      ws.__closeReason = reason;
    },
    fireOpen() {
      const arr = listeners.open ?? [];
      for (const fn of arr.slice()) fn();
    },
    fireMessage(json: unknown) {
      const data = JSON.stringify(json);
      const arr = listeners.message ?? [];
      for (const fn of arr.slice()) fn(data);
    },
    fireClose(code?: number, reason?: string) {
      const arr = listeners.close ?? [];
      for (const fn of arr.slice()) fn(code, reason ? Buffer.from(reason) : undefined);
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
  /** Make the next factory invocation throw synchronously. */
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
  flushOnce(): void;
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
    flushOnce() {
      const t = pending.shift();
      if (t) t.cb();
    },
  };
}

function makePrinter(overrides: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    id: 'printer-1',
    kind: 'fdm_klipper',
    connectionConfig: {
      host: '192.168.1.50',
      port: 7125,
      scheme: 'http',
      requiresAuth: true,
      startPrint: true,
    },
    ...(overrides as Record<string, unknown>),
  } as unknown as PrinterRecord;
}

function makeCredential(apiKey = 'test-api-key'): DecryptedCredential {
  return {
    id: 'cred-1',
    printerId: 'printer-1',
    kind: 'moonraker',
    payload: { apiKey },
    label: null,
    lastUsedAt: null,
  } as unknown as DecryptedCredential;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2-005f-T_dcf4 createMoonrakerSubscriber', () => {
  let factoryRig: FactoryRig;
  let timerRig: TimerRig;
  let events: StatusEvent[];

  beforeEach(() => {
    factoryRig = makeFactoryRig();
    timerRig = makeTimerRig();
    events = [];
  });

  function startSubscriber(opts: {
    printer?: PrinterRecord;
    credential?: DecryptedCredential | null;
  } = {}) {
    const sub = createMoonrakerSubscriber({
      wsFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10, 20, 30],
    });
    return {
      sub,
      promise: sub.start(
        opts.printer ?? makePrinter(),
        opts.credential === undefined ? makeCredential() : opts.credential,
        (e) => events.push(e),
      ),
    };
  }

  it('connects to ws://host:port/websocket and sends the JSON-RPC subscribe', async () => {
    const { sub } = startSubscriber();
    expect(factoryRig.calls).toHaveLength(1);
    expect(factoryRig.calls[0]!.url).toBe('ws://192.168.1.50:7125/websocket');

    const ws = factoryRig.sockets[0]!;
    ws.fireOpen();

    expect(ws.__sent).toHaveLength(1);
    const sent = JSON.parse(ws.__sent[0]!);
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('printer.objects.subscribe');
    expect(sent.id).toBe(1);
    expect(sent.params.objects.print_stats).toContain('state');
    expect(sent.params.objects.print_stats).toContain('filename');
    // V2-005f-CF-5a T_a2 regression: 'message' must be in the subscription so
    // Klipper delta updates carry print_stats.message on state='error'. Without
    // this, errorMessage is silently always undefined in production.
    expect(sent.params.objects.print_stats).toContain('message');
    // V2-005f-CF-5b T_b1 regression (FG-L4): 'filament_used' must be in the
    // subscription so Klipper sends delta updates for it. Without this, the
    // subscriber never sees filament_used values and measuredConsumption is
    // silently always undefined in production.
    expect(sent.params.objects.print_stats).toContain('filament_used');
    expect(sent.params.objects.display_status).toContain('progress');
    // Subscriber considers itself "connected" only after subscribe-reply.
    ws.fireMessage({ jsonrpc: '2.0', id: 1, result: { status: {}, eventtime: 0 } });
    expect(sub.isConnected()).toBe(true);

    await sub.stop();
  });

  it('emits progress event on notify_status_update with state=printing', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [
        {
          print_stats: { state: 'printing', filename: 'foo.gcode', filament_used: 1234.5 },
          display_status: { progress: 0.42 },
        },
        1234.567,
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('progress');
    expect(events[0]!.progressPct).toBe(42);
    expect(events[0]!.remoteJobRef).toBe('foo.gcode');
    expect(events[0]!.measuredConsumption).toBeUndefined();

    await sub.stop();
  });

  it('emits paused event on notify_status_update with state=paused', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [{ print_stats: { state: 'paused', filename: 'bar.gcode' } }, 0],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('paused');
    expect(events[0]!.remoteJobRef).toBe('bar.gcode');

    await sub.stop();
  });

  it('emits completed event on notify_history_changed with finished+completed', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: {
            job_id: 'j1',
            filename: 'baz.gcode',
            status: 'completed',
            filament_used: 1500,
            total_duration: 3600,
            print_duration: 3550,
          },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('completed');
    expect(events[0]!.remoteJobRef).toBe('baz.gcode');
    expect(events[0]!.measuredConsumption).toBeUndefined();

    await sub.stop();
  });

  it('emits cancelled event on notify_history_changed with finished+cancelled', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'x.gcode', status: 'cancelled' },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('cancelled');

    await sub.stop();
  });

  it('suppresses standby state (no event)', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [{ print_stats: { state: 'standby', filename: '' } }, 0],
    });

    expect(events).toHaveLength(0);

    await sub.stop();
  });

  it('passes X-Api-Key header when credential present and requiresAuth=true', async () => {
    const { sub } = startSubscriber();
    expect(factoryRig.calls[0]!.headers).toEqual({ 'X-Api-Key': 'test-api-key' });
    await sub.stop();
  });

  it('omits headers when requiresAuth=false', async () => {
    const printer = makePrinter({
      connectionConfig: {
        host: 'host',
        port: 7125,
        scheme: 'http',
        requiresAuth: false,
        startPrint: true,
      },
    } as unknown as Partial<PrinterRecord>);
    const { sub } = startSubscriber({ printer, credential: null });
    expect(factoryRig.calls[0]!.headers).toBeUndefined();
    await sub.stop();
  });

  it('uses wss scheme when scheme=https', async () => {
    const printer = makePrinter({
      connectionConfig: {
        host: 'klipper.local',
        port: 7130,
        scheme: 'https',
        requiresAuth: false,
        startPrint: true,
      },
    } as unknown as Partial<PrinterRecord>);
    const { sub } = startSubscriber({ printer, credential: null });
    expect(factoryRig.calls[0]!.url).toBe('wss://klipper.local:7130/websocket');
    await sub.stop();
  });

  it('reconnects after socket close', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { status: {}, eventtime: 0 },
    });
    expect(sub.isConnected()).toBe(true);

    factoryRig.sockets[0]!.fireClose();
    expect(sub.isConnected()).toBe(false);
    expect(factoryRig.calls).toHaveLength(1);
    expect(timerRig.pending).toHaveLength(1);

    timerRig.flushOnce();
    expect(factoryRig.calls).toHaveLength(2);

    await sub.stop();
  });

  it('does not reconnect after stop()', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    await sub.stop();

    factoryRig.sockets[0]!.fireClose();
    // No timer scheduled because stopped=true
    expect(timerRig.pending).toHaveLength(0);
    expect(factoryRig.calls).toHaveLength(1);
  });

  it('isConnected reflects open/close lifecycle', async () => {
    const { sub } = startSubscriber();
    expect(sub.isConnected()).toBe(false);
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { status: {}, eventtime: 0 },
    });
    expect(sub.isConnected()).toBe(true);
    factoryRig.sockets[0]!.fireClose();
    expect(sub.isConnected()).toBe(false);
    await sub.stop();
  });

  it('emits reconnected after a successful re-open', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireClose();
    timerRig.flushOnce();

    expect(factoryRig.sockets).toHaveLength(2);
    factoryRig.sockets[1]!.fireOpen();

    // After the subscribe round-trip is acknowledged, we surface 'reconnected'.
    factoryRig.sockets[1]!.fireMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { status: {}, eventtime: 0 },
    });

    const reconnected = events.find((e) => e.kind === 'reconnected');
    expect(reconnected).toBeDefined();
    expect(reconnected!.remoteJobRef).toBe('');

    await sub.stop();
  });

  it('emits unreachable when factory throws on first connect', async () => {
    factoryRig.failNext(new Error('ECONNREFUSED'));
    const sub = createMoonrakerSubscriber({
      wsFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10],
    });
    await sub.start(makePrinter(), makeCredential(), (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('unreachable');
    expect(timerRig.pending).toHaveLength(1);

    await sub.stop();
  });

  it('stop() is idempotent', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    await sub.stop();
    await expect(sub.stop()).resolves.toBeUndefined();
    expect(sub.isConnected()).toBe(false);
  });

  it('start() can be invoked again after stop() to restart', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    await sub.stop();
    expect(factoryRig.calls).toHaveLength(1);

    await sub.start(makePrinter(), makeCredential(), (e) => events.push(e));
    expect(factoryRig.calls).toHaveLength(2);

    await sub.stop();
  });

  it('emits unreachable once (not on every failed attempt) per disconnect cycle', async () => {
    factoryRig.failNext(new Error('ECONNREFUSED'));
    const sub = createMoonrakerSubscriber({
      wsFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10, 20, 30],
    });
    await sub.start(makePrinter(), makeCredential(), (e) => events.push(e));
    expect(events.filter((e) => e.kind === 'unreachable')).toHaveLength(1);

    // Second attempt also fails.
    factoryRig.failNext(new Error('ECONNREFUSED'));
    timerRig.flushOnce();
    expect(events.filter((e) => e.kind === 'unreachable')).toHaveLength(1);

    await sub.stop();
  });
});

// ---------------------------------------------------------------------------
// CF-5a state distinctions — V2-005f-CF-5a T_a2
// ---------------------------------------------------------------------------

describe('CF-5a state distinctions — V2-005f-CF-5a T_a2', () => {
  let factoryRig: FactoryRig;
  let timerRig: TimerRig;
  let events: StatusEvent[];

  beforeEach(() => {
    factoryRig = makeFactoryRig();
    timerRig = makeTimerRig();
    events = [];
  });

  function startSubscriber() {
    const sub = createMoonrakerSubscriber({
      wsFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10, 20, 30],
    });
    const promise = sub.start(makePrinter(), makeCredential(), (e) => events.push(e));
    return { sub, promise };
  }

  it('maps print_stats.state=cancelled → kind=cancelled', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [
        { print_stats: { state: 'cancelled', filename: 'my.gcode' } },
        12345.0,
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('cancelled');

    await sub.stop();
  });

  it('maps print_stats.state=error → kind=firmware_error + errorMessage from print_stats.message', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [
        {
          print_stats: {
            state: 'error',
            filename: 'my.gcode',
            message: 'Heater hotend failed',
          },
        },
        12345.0,
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('firmware_error');
    expect(events[0]!.errorMessage).toBe('Heater hotend failed');

    await sub.stop();
  });

  it('maps notify_history_changed status=cancelled → kind=cancelled', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'test.gcode', status: 'cancelled' },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('cancelled');

    await sub.stop();
  });

  it('maps notify_history_changed status=klippy_shutdown → kind=firmware_error with errorCode', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'test.gcode', status: 'klippy_shutdown' },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('firmware_error');
    expect(events[0]!.errorCode).toBe('klippy_shutdown');

    await sub.stop();
  });

  it('maps notify_history_changed status=interrupted → kind=cancelled', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'test.gcode', status: 'interrupted' },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('cancelled');

    await sub.stop();
  });

  it('maps notify_history_changed status=klippy_disconnect → kind=firmware_error with errorCode', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'test.gcode', status: 'klippy_disconnect' },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('firmware_error');
    expect(events[0]!.errorCode).toBe('klippy_disconnect');

    await sub.stop();
  });

  it('maps notify_history_changed status=server_exit → kind=firmware_error with errorCode', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'test.gcode', status: 'server_exit' },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('firmware_error');
    expect(events[0]!.errorCode).toBe('server_exit');

    await sub.stop();
  });

  it('maps notify_history_changed status=error → kind=firmware_error with no errorCode', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'test.gcode', status: 'error' },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('firmware_error');
    expect(events[0]!.errorCode).toBeUndefined();

    await sub.stop();
  });

  it('maps print_stats.state=error WITHOUT message → errorMessage undefined (not empty string)', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [
        { print_stats: { state: 'error', filename: 'my.gcode' } },
        12345.0,
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('firmware_error');
    expect(events[0]!.errorMessage).toBeUndefined();

    await sub.stop();
  });

  it('maps notify_history_changed unknown status → kind=failed (default branch)', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'test.gcode', status: 'in_progress' },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('failed');

    await sub.stop();
  });
});

// ---------------------------------------------------------------------------
// CF-5b T_b1 — Klipper filament_used capture + mm→grams conversion
// ---------------------------------------------------------------------------

describe('CF-5b T_b1 — Klipper filament_used capture + conversion', () => {
  let factoryRig: FactoryRig;
  let timerRig: TimerRig;
  let events: StatusEvent[];

  beforeEach(() => {
    factoryRig = makeFactoryRig();
    timerRig = makeTimerRig();
    events = [];
    vi.clearAllMocks();
  });

  function startSubscriber() {
    const sub = createMoonrakerSubscriber({
      wsFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10, 20, 30],
    });
    const promise = sub.start(makePrinter(), makeCredential(), (e) => events.push(e));
    return { sub, promise };
  }

  /** Flush micro-task queue so void promise chains in the subscriber complete. */
  async function flushPromises(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  it('populates measuredConsumption[0].grams on completed event when filament_used was reported', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();

    // Report filament_used during print via notify_status_update.
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [
        {
          print_stats: { state: 'printing', filename: 'test.gcode', filament_used: 1500.0 },
          display_status: { progress: 0.9 },
        },
        12345.0,
      ],
    });

    // Terminal event via notify_history_changed.
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'test.gcode', status: 'completed', filament_used: 1500.0 },
        },
      ],
    });

    // Wait for the void convertFilamentMmToGrams promise to resolve.
    await flushPromises();

    // The mocked conversion returns { grams: 2.98, densitySource: 'fallback' }.
    // First event is 'progress' (from notify_status_update), second is 'completed'.
    const completedEvent = events.find((e) => e.kind === 'completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent!.measuredConsumption).toBeDefined();
    expect(completedEvent!.measuredConsumption).toHaveLength(1);
    expect(completedEvent!.measuredConsumption![0]!.slot_index).toBe(0);
    expect(completedEvent!.measuredConsumption![0]!.grams).toBe(2.98);

    // Verify convertFilamentMmToGrams was called with the captured mm value.
    expect(convertFilamentMmToGrams).toHaveBeenCalledWith(
      expect.objectContaining({ filamentUsedMm: 1500.0, slotIndex: 0 }),
    );

    await sub.stop();
  });

  it('does NOT populate measuredConsumption when filament_used was never reported', async () => {
    const { sub } = startSubscriber();
    factoryRig.sockets[0]!.fireOpen();

    // Fire the terminal event directly without any prior notify_status_update
    // containing filament_used — latestFilamentUsedMm stays null.
    factoryRig.sockets[0]!.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: { filename: 'test.gcode', status: 'completed' },
        },
      ],
    });

    await flushPromises();

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('completed');
    expect(events[0]!.measuredConsumption).toBeUndefined();

    // convertFilamentMmToGrams must NOT have been called (no filament_used seen).
    expect(convertFilamentMmToGrams).not.toHaveBeenCalled();

    await sub.stop();
  });
});
