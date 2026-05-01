/**
 * Unit tests for V2-005f-T_dcf4 — Moonraker status subscriber.
 *
 * Injects a fake `WsClientLike` factory and a manual timer scheduler so
 * each scenario drives reconnect + JSON-RPC handling deterministically.
 */

import { describe, it, expect, beforeEach } from 'vitest';

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
    expect(sent.params.objects.display_status).toContain('progress');
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

  it('emits failed event on notify_history_changed with finished+cancelled', async () => {
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
    expect(events[0]!.kind).toBe('failed');

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
