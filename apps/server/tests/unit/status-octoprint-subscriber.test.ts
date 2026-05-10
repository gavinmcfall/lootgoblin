/**
 * Unit tests for V2-005f-T_dcf5 — OctoPrint status subscriber.
 *
 * Same shape as `status-moonraker-subscriber.test.ts`: inject a fake
 * WebSocket factory + manual timer scheduler + fake httpClient for the
 * `/login` call. Each scenario drives SockJS framing deterministically.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createOctoprintSubscriber,
} from '@/forge/status/subscribers/octoprint';
import type { WsClientLike, WsFactory } from '@/forge/status/subscribers/_ws-client';
import type { HttpClient } from '@/forge/dispatch/handler';
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
  /** Send a SockJS-framed string verbatim. */
  fireRawMessage(text: string): void;
  /** Convenience: send `a[<json strings>]` array frame. */
  fireArrayFrame(messages: unknown[]): void;
  /** Convenience: send the SockJS open frame ('o'). */
  fireOpenFrame(): void;
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
    fireRawMessage(text: string) {
      const arr = listeners.message ?? [];
      for (const fn of arr.slice()) fn(text);
    },
    fireArrayFrame(messages: unknown[]) {
      const encoded = messages.map((m) => (typeof m === 'string' ? m : JSON.stringify(m)));
      ws.fireRawMessage('a' + JSON.stringify(encoded));
    },
    fireOpenFrame() {
      ws.fireRawMessage('o');
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

interface HttpRig {
  client: HttpClient;
  calls: Array<{ url: string; init?: RequestInit }>;
  /** Set the next reply (status + body). */
  setReply(opts: { status?: number; body?: unknown }): void;
  /** Make the next call throw. */
  failNext(err: Error): void;
}

function makeHttpRig(): HttpRig {
  const calls: HttpRig['calls'] = [];
  let nextReply: { status: number; body: unknown } = {
    status: 200,
    body: { name: 'octouser', session: 'sess-abc' },
  };
  let failure: Error | null = null;
  const client: HttpClient = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (failure) {
        const err = failure;
        failure = null;
        throw err;
      }
      const reply = nextReply;
      // Reset to default for subsequent calls
      nextReply = { status: 200, body: { name: 'octouser', session: 'sess-abc' } };
      const bodyText =
        typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
      return new Response(bodyText, {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
  return {
    client,
    calls,
    setReply(opts) {
      nextReply = {
        status: opts.status ?? 200,
        body: opts.body ?? { name: 'octouser', session: 'sess-abc' },
      };
    },
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
    kind: 'fdm_octoprint',
    connectionConfig: {
      host: '192.168.1.51',
      port: 80,
      scheme: 'http',
      apiPath: '/api',
      requiresAuth: true,
      select: true,
      startPrint: true,
    },
    ...(overrides as Record<string, unknown>),
  } as unknown as PrinterRecord;
}

function makeCredential(apiKey = 'op-api-key'): DecryptedCredential {
  return {
    id: 'cred-1',
    printerId: 'printer-1',
    kind: 'octoprint_api_key',
    payload: { apiKey },
    label: null,
    lastUsedAt: null,
  } as unknown as DecryptedCredential;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2-005f-T_dcf5 createOctoprintSubscriber', () => {
  let factoryRig: FactoryRig;
  let httpRig: HttpRig;
  let timerRig: TimerRig;
  let events: StatusEvent[];

  beforeEach(() => {
    factoryRig = makeFactoryRig();
    httpRig = makeHttpRig();
    timerRig = makeTimerRig();
    events = [];
  });

  function startSubscriber(opts: {
    printer?: PrinterRecord;
    credential?: DecryptedCredential | null;
  } = {}) {
    const sub = createOctoprintSubscriber({
      wsFactory: factoryRig.factory,
      httpClient: httpRig.client,
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

  it('connects with auth: HTTP login + auth message after o-frame', async () => {
    const { promise } = startSubscriber();
    await promise;

    // HTTP login was made with X-Api-Key
    expect(httpRig.calls).toHaveLength(1);
    expect(httpRig.calls[0]!.url).toBe('http://192.168.1.51:80/api/login');
    const headers = httpRig.calls[0]!.init?.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('op-api-key');

    // WS opens at /sockjs/websocket
    expect(factoryRig.calls).toHaveLength(1);
    expect(factoryRig.calls[0]!.url).toBe('ws://192.168.1.51:80/sockjs/websocket');

    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();

    // Auth message should have been sent
    expect(ws.__sent).toHaveLength(1);
    const sent = JSON.parse(ws.__sent[0]!);
    expect(sent.auth).toBe('octouser:sess-abc');
  });

  it('connects without auth (requiresAuth=false): no HTTP call, no auth message, ready after o-frame', async () => {
    const printer = makePrinter({
      connectionConfig: {
        host: 'op.local',
        port: 5000,
        scheme: 'http',
        apiPath: '/api',
        requiresAuth: false,
        select: true,
        startPrint: true,
      },
    } as unknown as Partial<PrinterRecord>);
    const { sub, promise } = startSubscriber({ printer, credential: null });
    await promise;

    expect(httpRig.calls).toHaveLength(0);
    expect(factoryRig.calls[0]!.url).toBe('ws://op.local:5000/sockjs/websocket');

    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();

    expect(ws.__sent).toHaveLength(0);
    expect(sub.isConnected()).toBe(true);

    await sub.stop();
  });

  it('uses wss when scheme=https', async () => {
    const printer = makePrinter({
      connectionConfig: {
        host: 'op.lan',
        port: 443,
        scheme: 'https',
        apiPath: '/api',
        requiresAuth: false,
        select: true,
        startPrint: true,
      },
    } as unknown as Partial<PrinterRecord>);
    const { sub, promise } = startSubscriber({ printer, credential: null });
    await promise;
    expect(factoryRig.calls[0]!.url).toBe('wss://op.lan:443/sockjs/websocket');
    await sub.stop();
  });

  it('emits progress on current.state.text=Printing', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    // First array frame after auth-send marks "fully ready".
    ws.fireArrayFrame([
      {
        current: {
          state: { text: 'Printing' },
          progress: { completion: 42.7, printTimeLeft: 600 },
          job: { file: { name: 'foo.gcode', path: 'local/foo.gcode' } },
        },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('progress');
    expect(events[0]!.progressPct).toBe(43);
    expect(events[0]!.remoteJobRef).toBe('foo.gcode');
    expect(events[0]!.remainingMin).toBe(10);
    expect(events[0]!.measuredConsumption).toBeUndefined();
    await sub.stop();
  });

  it('emits paused on current.state.text=Paused', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    ws.fireArrayFrame([
      {
        current: {
          state: { text: 'Paused' },
          progress: { completion: 11.1 },
          job: { file: { name: 'bar.gcode' } },
        },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('paused');
    expect(events[0]!.remoteJobRef).toBe('bar.gcode');
    await sub.stop();
  });

  it('emits completed on event.type=PrintDone', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    ws.fireArrayFrame([
      { event: { type: 'PrintDone', payload: { name: 'baz.gcode', path: 'local/baz.gcode' } } },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('completed');
    expect(events[0]!.remoteJobRef).toBe('baz.gcode');
    expect(events[0]!.progressPct).toBe(100);
    await sub.stop();
  });

  it('emits failed on event.type=PrintFailed', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    ws.fireArrayFrame([{ event: { type: 'PrintFailed', payload: { name: 'x.gcode' } } }]);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('failed');
    expect(events[0]!.remoteJobRef).toBe('x.gcode');
    await sub.stop();
  });

  it('emits cancelled on event.type=PrintCancelled (T_a3: distinct from failed)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    ws.fireArrayFrame([{ event: { type: 'PrintCancelled', payload: { name: 'y.gcode' } } }]);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('cancelled');
    await sub.stop();
  });

  it('emits started on event.type=PrintStarted', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    ws.fireArrayFrame([{ event: { type: 'PrintStarted', payload: { name: 'z.gcode' } } }]);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('started');
    expect(events[0]!.remoteJobRef).toBe('z.gcode');
    await sub.stop();
  });

  it('suppresses Operational state (no event)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    ws.fireArrayFrame([
      { current: { state: { text: 'Operational' }, progress: { completion: 0 } } },
    ]);

    // Initial array-frame still marks authed/ready, but no protocol event emitted.
    expect(events.filter((e) => e.kind !== 'reconnected' && e.kind !== 'unreachable'))
      .toHaveLength(0);
    await sub.stop();
  });

  it('suppresses Cancelling state (no event)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    ws.fireArrayFrame([{ current: { state: { text: 'Cancelling' } } }]);

    expect(events).toHaveLength(0);
    await sub.stop();
  });

  it("ignores 'h' heartbeat frames", async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    ws.fireRawMessage('h');
    ws.fireRawMessage('h');
    ws.fireRawMessage('h');

    expect(events).toHaveLength(0);
    await sub.stop();
  });

  it('tolerates malformed SockJS messages', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();

    // Garbage payloads — must not throw or crash subscriber.
    ws.fireRawMessage('a[not valid json');
    ws.fireRawMessage('z?');
    ws.fireRawMessage('');
    ws.fireRawMessage('a{not an array}');

    // Still functional afterwards
    ws.fireArrayFrame([
      {
        current: {
          state: { text: 'Printing' },
          progress: { completion: 5 },
          job: { file: { name: 'a.gcode' } },
        },
      },
    ]);

    expect(events.find((e) => e.kind === 'progress')).toBeDefined();
    await sub.stop();
  });

  it('reconnects after socket close (delegated to base)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    // First array-frame after auth-send completes the handshake.
    ws.fireArrayFrame([{ connected: { version: '1.10.0' } }]);
    expect(sub.isConnected()).toBe(true);

    ws.fireClose();
    expect(sub.isConnected()).toBe(false);
    expect(timerRig.pending).toHaveLength(1);

    timerRig.flushOnce();
    // Wait for the second login + ws to open.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(factoryRig.calls.length).toBeGreaterThanOrEqual(2);

    await sub.stop();
  });

  it('stop() is idempotent', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    factoryRig.sockets[0]!.fireOpenFrame();
    await sub.stop();
    await expect(sub.stop()).resolves.toBeUndefined();
    expect(sub.isConnected()).toBe(false);
  });

  it('does not reconnect after stop()', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    factoryRig.sockets[0]!.fireOpenFrame();
    await sub.stop();
    factoryRig.sockets[0]!.fireClose();
    expect(timerRig.pending).toHaveLength(0);
    expect(factoryRig.calls).toHaveLength(1);
  });

  it('emits reconnected after a successful re-open', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const ws1 = factoryRig.sockets[0]!;
    ws1.fireOpenFrame();
    // Send first array-frame to mark fully-ready (so disconnect counts as `wasConnected`).
    ws1.fireArrayFrame([{ connected: { version: '1.10.0' } }]);
    ws1.fireClose();
    timerRig.flushOnce();
    // Allow the async openTransport to run.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(factoryRig.sockets).toHaveLength(2);
    const ws2 = factoryRig.sockets[1]!;
    ws2.fireOpenFrame();
    ws2.fireArrayFrame([{ connected: { version: '1.10.0' } }]);

    const reconnected = events.find((e) => e.kind === 'reconnected');
    expect(reconnected).toBeDefined();

    await sub.stop();
  });

  it('emits unreachable when login HTTP throws', async () => {
    httpRig.failNext(new Error('ECONNREFUSED'));
    const sub = createOctoprintSubscriber({
      wsFactory: factoryRig.factory,
      httpClient: httpRig.client,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10],
    });
    await sub.start(makePrinter(), makeCredential(), (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('unreachable');
    await sub.stop();
  });
});

// ---------------------------------------------------------------------------
// CF-5a OctoPrint event mapping — T_a3
// ---------------------------------------------------------------------------
//
// OctoPrint's SockJS API does NOT have field-level subscriptions: once the
// socket is open and authenticated, OctoPrint broadcasts ALL event types to
// ALL connected clients. There is no subscribe/select payload to filter event
// types server-side. The subscriber reads every incoming event and applies
// client-side routing via `mapEventType`. This is documented at
// https://docs.octoprint.org/en/master/api/push.html — the `event` message
// type carries arbitrary event.type strings; there is no subscription message.
// Therefore no subscription-filter regression test is required; the comment
// above serves as the future-reviewer documentation per the T_a3 lesson from
// T_a2 (FG-L4).
//
// Supported plugin warning sources (conservative allowlist):
//   - 'OctoPrint-Spool Manager' — filament runout / low-filament advisories
// Unknown plugin events are routed through the existing audit-only path and
// do NOT emit a 'warning' StatusEvent.

describe('CF-5a OctoPrint event mapping — T_a3', () => {
  let factoryRig: FactoryRig;
  let httpRig: HttpRig;
  let timerRig: TimerRig;
  let events: StatusEvent[];

  beforeEach(() => {
    factoryRig = makeFactoryRig();
    httpRig = makeHttpRig();
    timerRig = makeTimerRig();
    events = [];
  });

  function startAndConnect(opts: {
    printer?: PrinterRecord;
    credential?: DecryptedCredential | null;
  } = {}) {
    const sub = createOctoprintSubscriber({
      wsFactory: factoryRig.factory,
      httpClient: httpRig.client,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10, 20, 30],
    });
    const promise = sub.start(
      opts.printer ?? makePrinter(),
      opts.credential === undefined ? makeCredential() : opts.credential,
      (e) => events.push(e),
    );
    return { sub, promise };
  }

  async function openSocket() {
    const { sub, promise } = startAndConnect();
    await promise;
    const ws = factoryRig.sockets[0]!;
    ws.fireOpenFrame();
    // First array frame marks auth complete.
    ws.fireArrayFrame([{ connected: { version: '1.10.0' } }]);
    return { sub, ws };
  }

  it('maps event.type=PrintCancelled → kind=cancelled', async () => {
    const { sub, ws } = await openSocket();
    ws.fireArrayFrame([
      { event: { type: 'PrintCancelled', payload: { name: 'cancel-me.gcode' } } },
    ]);

    const ev = events.find((e) => e.kind === 'cancelled');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('cancelled');
    expect(ev!.remoteJobRef).toBe('cancel-me.gcode');
    // PrintCancelled has no errorCode — OctoPrint doesn't report why the cancel was requested.
    expect(ev!.errorCode).toBeUndefined();
    expect(ev!.errorMessage).toBeUndefined();
    expect(ev!.severity).toBeUndefined();
    await sub.stop();
  });

  it('maps event.type=PrintFailed reason=cancelled → kind=cancelled', async () => {
    const { sub, ws } = await openSocket();
    ws.fireArrayFrame([
      {
        event: {
          type: 'PrintFailed',
          payload: { name: 'failed-cancel.gcode', reason: 'cancelled' },
        },
      },
    ]);

    const ev = events.find((e) => e.kind === 'cancelled');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('cancelled');
    expect(ev!.remoteJobRef).toBe('failed-cancel.gcode');
    expect(ev!.errorCode).toBeUndefined();
    expect(ev!.severity).toBeUndefined();
    await sub.stop();
  });

  it('maps event.type=PrintFailed reason=error → kind=firmware_error', async () => {
    const { sub, ws } = await openSocket();
    ws.fireArrayFrame([
      {
        event: {
          type: 'PrintFailed',
          payload: { name: 'failed-error.gcode', reason: 'error', message: 'Thermal runaway' },
        },
      },
    ]);

    const ev = events.find((e) => e.kind === 'firmware_error');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('firmware_error');
    expect(ev!.remoteJobRef).toBe('failed-error.gcode');
    // OctoPrint's PrintFailed does not carry a machine error code — errorCode is undefined.
    expect(ev!.errorCode).toBeUndefined();
    expect(ev!.errorMessage).toBe('Thermal runaway');
    await sub.stop();
  });

  it('maps event.type=Error consequence=disconnect → kind=firmware_error with errorCode', async () => {
    const { sub, ws } = await openSocket();
    ws.fireArrayFrame([
      {
        event: {
          type: 'Error',
          payload: {
            error: 'Thermal runaway',
            reason: 'gcode_other_error',
            consequence: 'disconnect',
          },
        },
      },
    ]);

    const ev = events.find((e) => e.kind === 'firmware_error');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('firmware_error');
    // Error.reason is the protocol-native code (7-value enum).
    expect(ev!.errorCode).toBe('gcode_other_error');
    expect(ev!.errorMessage).toBe('Thermal runaway');
    expect(ev!.severity).toBe('error');
    await sub.stop();
  });

  it('maps event.type=Error without consequence → kind=firmware_error, severity=undefined', async () => {
    const { sub, ws } = await openSocket();
    ws.fireArrayFrame([
      {
        event: {
          type: 'Error',
          payload: {
            error: 'Heater timeout',
            reason: 'heater_timeout',
            // no consequence — firmware kept running
          },
        },
      },
    ]);

    const ev = events.find((e) => e.kind === 'firmware_error');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('firmware_error');
    expect(ev!.errorCode).toBe('heater_timeout');
    expect(ev!.errorMessage).toBe('Heater timeout');
    // No consequence → severity stays undefined.
    expect(ev!.severity).toBeUndefined();
    await sub.stop();
  });

  it('maps PrintCancelling.firmwareError=true → kind=cancelled with errorCode=firmware-cancel', async () => {
    const { sub, ws } = await openSocket();
    ws.fireArrayFrame([
      {
        event: {
          type: 'PrintCancelling',
          payload: { firmwareError: true, name: 'fw-cancel.gcode' },
        },
      },
    ]);

    const ev = events.find((e) => e.kind === 'cancelled');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('cancelled');
    expect(ev!.errorCode).toBe('firmware-cancel');
    expect(ev!.remoteJobRef).toBe('fw-cancel.gcode');
    await sub.stop();
  });

  it('maps OctoPrint-Spool Manager plugin warning → kind=warning with severity=warning', async () => {
    const { sub, ws } = await openSocket();
    ws.fireArrayFrame([
      {
        plugin: {
          plugin: 'OctoPrint-Spool Manager',
          data: { action: 'warning', code: 'low_filament', message: 'Less than 10g remaining' },
        },
      },
    ]);

    const ev = events.find((e) => e.kind === 'warning');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('warning');
    expect(ev!.severity).toBe('warning');
    expect(ev!.errorCode).toBe('OctoPrint-Spool Manager/low_filament');
    expect(ev!.errorMessage).toBe('Less than 10g remaining');
    await sub.stop();
  });

  it('plugin warning with no data.code → errorCode fallback to <plugin>/warning', async () => {
    const { sub, ws } = await openSocket();
    ws.fireArrayFrame([
      {
        plugin: {
          plugin: 'OctoPrint-Spool Manager',
          // no code — only message
          data: { message: 'something happened' },
        },
      },
    ]);

    const ev = events.find((e) => e.kind === 'warning');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('warning');
    expect(ev!.errorCode).toBe('OctoPrint-Spool Manager/warning');
    expect(ev!.errorMessage).toBe('something happened');
    expect(ev!.severity).toBe('warning');
    await sub.stop();
  });

  it('does NOT emit warning for unknown plugin events (audit-only path)', async () => {
    const { sub, ws } = await openSocket();
    ws.fireArrayFrame([
      {
        plugin: {
          plugin: 'SomeUnknownPlugin',
          data: { code: 'some_code', message: 'something happened' },
        },
      },
    ]);

    // No warning event should be emitted — unknown plugins stay on audit-only path.
    const warningEvt = events.find((e) => e.kind === 'warning');
    expect(warningEvt).toBeUndefined();
    await sub.stop();
  });
});
