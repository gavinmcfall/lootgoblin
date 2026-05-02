/**
 * Unit tests for V2-005f-T_dcf6 — Bambu LAN status subscriber.
 *
 * Mocks the MQTT client via `MqttFactory`. Each test drives a deterministic
 * sequence of `connect` / `message` / `close` events and asserts the
 * resulting StatusEvent shape.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createBambuSubscriber,
  mapBambuState,
  extractAmsSlots,
  buildBambuEvent,
} from '@/forge/status/subscribers/bambu';
import type {
  MqttClientLike,
  MqttFactory,
} from '@/forge/dispatch/bambu/adapter';
import type {
  StatusEvent,
  PrinterRecord,
  DecryptedCredential,
} from '@/forge/status';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeMqtt extends MqttClientLike {
  __listeners: Record<string, Listener[]>;
  __subscriptions: Array<{ topic: string; opts: { qos?: 0 | 1 | 2 } }>;
  __ended: boolean;
  fireConnect(): void;
  fireMessage(topic: string, payload: unknown): void;
  fireClose(): void;
  fireError(err: Error): void;
}

function makeFakeMqtt(): FakeMqtt {
  const listeners: Record<string, Listener[]> = {};
  const subs: FakeMqtt['__subscriptions'] = [];
  const client: FakeMqtt = {
    __listeners: listeners,
    __subscriptions: subs,
    __ended: false,
    publish(_topic: string, _payload: string, _opts: object, cb: (err?: Error) => void) {
      cb(undefined);
    },
    subscribe(topic: string, opts: { qos?: 0 | 1 | 2 }, cb: (err: Error | null) => void) {
      subs.push({ topic, opts });
      cb(null);
    },
    end(_force?: boolean, cb?: () => void) {
      client.__ended = true;
      cb?.();
    },
    on(event: string, listener: Listener) {
      (listeners[event] ??= []).push(listener);
    },
    once(event: string, listener: Listener) {
      const wrap = (...args: unknown[]) => {
        listener(...args);
        const arr = listeners[event];
        if (arr) {
          const idx = arr.indexOf(wrap);
          if (idx >= 0) arr.splice(idx, 1);
        }
      };
      (listeners[event] ??= []).push(wrap);
    },
    fireConnect() {
      const arr = listeners.connect ?? [];
      for (const fn of arr.slice()) fn();
    },
    fireMessage(topic: string, payload: unknown) {
      const arr = listeners.message ?? [];
      for (const fn of arr.slice()) fn(topic, payload);
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
  return client;
}

interface FactoryRig {
  factory: MqttFactory;
  calls: Array<{
    url: string;
    opts: { username: string; password: string; clientId: string; rejectUnauthorized: boolean };
  }>;
  clients: FakeMqtt[];
  failNext(err: Error): void;
}

function makeFactoryRig(): FactoryRig {
  const calls: FactoryRig['calls'] = [];
  const clients: FakeMqtt[] = [];
  let failure: Error | null = null;
  const factory: MqttFactory = (url, opts) => {
    calls.push({ url, opts });
    if (failure) {
      const err = failure;
      failure = null;
      throw err;
    }
    const client = makeFakeMqtt();
    clients.push(client);
    return client;
  };
  return {
    factory,
    calls,
    clients,
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
    id: 'printer-bambu-1',
    kind: 'bambu_x1c',
    connectionConfig: {
      ip: '192.168.1.77',
      mqttPort: 8883,
      ftpPort: 990,
      startPrint: true,
      forceAmsDisabled: false,
      plateIndex: 1,
      bedLevelling: true,
      flowCalibration: true,
      vibrationCalibration: true,
      layerInspect: false,
      timelapse: false,
      bedType: 'auto',
    },
    ...(overrides as Record<string, unknown>),
  } as unknown as PrinterRecord;
}

function makeCredential(
  accessCode = 'ABCD1234',
  serial = '01ABCDEFGHIJKL',
): DecryptedCredential {
  return {
    id: 'cred-bambu-1',
    printerId: 'printer-bambu-1',
    kind: 'bambu_lan',
    payload: { accessCode, serial },
    label: null,
    lastUsedAt: null,
  } as unknown as DecryptedCredential;
}

// Build a minimal pushall envelope for tests.
function pushall(printOverrides: Record<string, unknown>): unknown {
  return {
    print: {
      command: 'pushing',
      msg: 0,
      sequence_id: '1',
      ...printOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

describe('V2-005f-T_dcf6 mapBambuState', () => {
  it('maps every documented gcode_state', () => {
    expect(mapBambuState('IDLE')).toBeNull();
    expect(mapBambuState('PREPARE')).toBe('started');
    expect(mapBambuState('RUNNING')).toBe('progress');
    expect(mapBambuState('PAUSE')).toBe('paused');
    expect(mapBambuState('FINISH')).toBe('completed');
    expect(mapBambuState('FAILED')).toBe('failed');
  });

  it('returns null for unknown / undefined values', () => {
    expect(mapBambuState(undefined)).toBeNull();
    expect(mapBambuState('')).toBeNull();
    expect(mapBambuState('LOL')).toBeNull();
  });
});

describe('V2-005f-T_dcf6 extractAmsSlots', () => {
  it('returns [] for missing/empty ams', () => {
    expect(extractAmsSlots(undefined)).toEqual([]);
    expect(extractAmsSlots({})).toEqual([]);
    expect(extractAmsSlots({ ams: [] })).toEqual([]);
  });

  it('flattens 2 AMS units × 4 slots into 8 entries with global slot indices', () => {
    const slots = extractAmsSlots({
      ams: [
        {
          id: '0',
          tray: [
            { id: '0', tray_type: 'PLA', remain: 80 },
            { id: '1', tray_type: 'PETG', remain: 50 },
            { id: '2', tray_type: 'PLA', remain: 30 },
            { id: '3', tray_type: 'ABS', remain: 100 },
          ],
        },
        {
          id: '1',
          tray: [
            { id: '0', tray_type: 'PLA', remain: 90 },
            { id: '1', tray_type: 'PETG', remain: 70 },
            { id: '2', tray_type: 'PLA', remain: 60 },
            { id: '3', tray_type: 'ABS', remain: 25 },
          ],
        },
      ],
    });
    expect(slots).toHaveLength(8);
    expect(slots.map((s) => s.slot_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(slots[0]!.remain_percent).toBe(80);
    expect(slots[7]!.remain_percent).toBe(25);
    // grams placeholder until T_dcf11
    expect(slots.every((s) => s.grams === 0)).toBe(true);
  });

  it('omits remain_percent when tray.remain absent', () => {
    const slots = extractAmsSlots({
      ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PLA' }] }],
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]!.remain_percent).toBeUndefined();
    expect(slots[0]!.grams).toBe(0);
    expect(slots[0]!.slot_index).toBe(0);
  });
});

describe('V2-005f-T_dcf6 buildBambuEvent', () => {
  it('passes through progress fields on RUNNING events; omits measuredConsumption', () => {
    const ev = buildBambuEvent(
      pushall({
        gcode_state: 'RUNNING',
        mc_percent: 42,
        mc_remaining_time: 1200,
        layer_num: 12,
        total_layer_num: 256,
        subtask_name: 'foo.gcode',
        ams: { ams: [{ id: '0', tray: [{ id: '0', remain: 80 }] }] },
      }) as Parameters<typeof buildBambuEvent>[0],
      'progress',
      new Date(0),
    );
    expect(ev.kind).toBe('progress');
    expect(ev.progressPct).toBe(42);
    expect(ev.remainingMin).toBe(20); // 1200s / 60
    expect(ev.layerNum).toBe(12);
    expect(ev.totalLayers).toBe(256);
    expect(ev.remoteJobRef).toBe('foo.gcode');
    expect(ev.measuredConsumption).toBeUndefined();
  });

  it('populates measuredConsumption on completed events', () => {
    const ev = buildBambuEvent(
      pushall({
        gcode_state: 'FINISH',
        subtask_name: 'foo.gcode',
        mc_percent: 100,
        ams: {
          ams: [{ id: '0', tray: [{ id: '0', remain: 60 }, { id: '1', remain: 30 }] }],
        },
      }) as Parameters<typeof buildBambuEvent>[0],
      'completed',
      new Date(0),
    );
    expect(ev.measuredConsumption).toHaveLength(2);
    expect(ev.measuredConsumption![0]!.slot_index).toBe(0);
    expect(ev.measuredConsumption![0]!.remain_percent).toBe(60);
    expect(ev.measuredConsumption![1]!.slot_index).toBe(1);
    expect(ev.measuredConsumption![1]!.remain_percent).toBe(30);
  });

  it('omits measuredConsumption on completed events when no AMS data', () => {
    const ev = buildBambuEvent(
      pushall({ gcode_state: 'FINISH', subtask_name: 'no-ams.gcode' }) as Parameters<
        typeof buildBambuEvent
      >[0],
      'completed',
      new Date(0),
    );
    expect(ev.measuredConsumption).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Subscriber lifecycle tests
// ---------------------------------------------------------------------------

describe('V2-005f-T_dcf6 createBambuSubscriber', () => {
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
    const sub = createBambuSubscriber({
      printerKind: 'bambu_x1c',
      mqttFactory: factoryRig.factory,
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

  it('connects MQTT with mqtts:// URL + bblp + accessCode + rejectUnauthorized=false', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    expect(factoryRig.calls).toHaveLength(1);
    expect(factoryRig.calls[0]!.url).toBe('mqtts://192.168.1.77:8883');
    expect(factoryRig.calls[0]!.opts.username).toBe('bblp');
    expect(factoryRig.calls[0]!.opts.password).toBe('ABCD1234');
    expect(factoryRig.calls[0]!.opts.rejectUnauthorized).toBe(false);
    expect(factoryRig.calls[0]!.opts.clientId).toMatch(/^lootgoblin-status-/);
    await sub.stop();
  });

  it('subscribes to device/<serial>/report on connect', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    expect(client.__subscriptions).toHaveLength(1);
    expect(client.__subscriptions[0]!.topic).toBe('device/01ABCDEFGHIJKL/report');
    await sub.stop();
  });

  it('first pushall message marks subscriber connected', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    expect(sub.isConnected()).toBe(false);
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      Buffer.from(
        JSON.stringify(pushall({ gcode_state: 'IDLE' })),
        'utf8',
      ),
    );
    expect(sub.isConnected()).toBe(true);
    // IDLE → no protocol event
    expect(events).toHaveLength(0);
    await sub.stop();
  });

  it('emits progress on RUNNING with progress + layer + remaining minutes', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(
        pushall({
          gcode_state: 'RUNNING',
          mc_percent: 42,
          mc_remaining_time: 1200,
          layer_num: 12,
          total_layer_num: 256,
          subtask_name: 'foo.gcode',
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('progress');
    expect(events[0]!.progressPct).toBe(42);
    expect(events[0]!.layerNum).toBe(12);
    expect(events[0]!.totalLayers).toBe(256);
    expect(events[0]!.remainingMin).toBe(20);
    expect(events[0]!.remoteJobRef).toBe('foo.gcode');
    expect(events[0]!.measuredConsumption).toBeUndefined();
    await sub.stop();
  });

  it('emits paused on PAUSE', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(pushall({ gcode_state: 'PAUSE', subtask_name: 'foo.gcode' })),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('paused');
    await sub.stop();
  });

  it('emits started on PREPARE', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(pushall({ gcode_state: 'PREPARE', subtask_name: 'foo.gcode' })),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('started');
    await sub.stop();
  });

  it('emits completed on FINISH with measuredConsumption populated', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(
        pushall({
          gcode_state: 'FINISH',
          mc_percent: 100,
          subtask_name: 'foo.gcode',
          ams: {
            ams: [
              {
                id: '0',
                tray: [
                  { id: '0', tray_type: 'PLA', remain: 60 },
                  { id: '1', tray_type: 'PETG', remain: 30 },
                ],
              },
            ],
          },
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('completed');
    expect(events[0]!.measuredConsumption).toHaveLength(2);
    expect(events[0]!.measuredConsumption![0]!.slot_index).toBe(0);
    expect(events[0]!.measuredConsumption![0]!.remain_percent).toBe(60);
    expect(events[0]!.measuredConsumption![1]!.slot_index).toBe(1);
    expect(events[0]!.measuredConsumption![1]!.remain_percent).toBe(30);
    expect(events[0]!.measuredConsumption![0]!.grams).toBe(0);
    await sub.stop();
  });

  it('emits failed on FAILED with measuredConsumption', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(
        pushall({
          gcode_state: 'FAILED',
          subtask_name: 'foo.gcode',
          ams: { ams: [{ id: '0', tray: [{ id: '0', remain: 75 }] }] },
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('failed');
    expect(events[0]!.measuredConsumption).toHaveLength(1);
    await sub.stop();
  });

  it('IDLE state emits no protocol event (only marks connected)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(pushall({ gcode_state: 'IDLE' })),
    );
    expect(events).toHaveLength(0);
    expect(sub.isConnected()).toBe(true);
    await sub.stop();
  });

  it('multi-AMS-unit completion produces 8 slots with global indices', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(
        pushall({
          gcode_state: 'FINISH',
          subtask_name: 'multi.gcode',
          ams: {
            ams: [
              {
                id: '0',
                tray: [
                  { id: '0', remain: 80 },
                  { id: '1', remain: 50 },
                  { id: '2', remain: 30 },
                  { id: '3', remain: 100 },
                ],
              },
              {
                id: '1',
                tray: [
                  { id: '0', remain: 90 },
                  { id: '1', remain: 70 },
                  { id: '2', remain: 60 },
                  { id: '3', remain: 25 },
                ],
              },
            ],
          },
        }),
      ),
    );
    expect(events).toHaveLength(1);
    const slots = events[0]!.measuredConsumption!;
    expect(slots).toHaveLength(8);
    expect(slots.map((s) => s.slot_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(slots[7]!.remain_percent).toBe(25);
    await sub.stop();
  });

  it('completion with no AMS field yields no measuredConsumption', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(pushall({ gcode_state: 'FINISH', subtask_name: 'no-ams.gcode' })),
    );
    expect(events[0]!.measuredConsumption).toBeUndefined();
    await sub.stop();
  });

  it('tolerates malformed JSON payloads without emitting events', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage('device/01ABCDEFGHIJKL/report', 'not json{{{');
    client.fireMessage('device/01ABCDEFGHIJKL/report', '');
    client.fireMessage('device/01ABCDEFGHIJKL/report', null);
    expect(events).toHaveLength(0);
    expect(sub.isConnected()).toBe(false); // never saw a valid pushall
    await sub.stop();
  });

  it('ignores messages on other topics', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/request',
      JSON.stringify(pushall({ gcode_state: 'RUNNING', subtask_name: 'x.gcode' })),
    );
    client.fireMessage(
      'random/topic',
      JSON.stringify(pushall({ gcode_state: 'FINISH' })),
    );
    expect(events).toHaveLength(0);
    expect(sub.isConnected()).toBe(false);
    await sub.stop();
  });

  it('schedules reconnect on close (delegated to base)', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(pushall({ gcode_state: 'IDLE' })),
    );
    expect(sub.isConnected()).toBe(true);

    client.fireClose();
    expect(sub.isConnected()).toBe(false);
    expect(timerRig.pending).toHaveLength(1);

    timerRig.flushOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(factoryRig.calls.length).toBeGreaterThanOrEqual(2);

    await sub.stop();
  });

  it('emits reconnected after a successful re-open', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client1 = factoryRig.clients[0]!;
    client1.fireConnect();
    client1.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(pushall({ gcode_state: 'IDLE' })),
    );
    client1.fireClose();

    timerRig.flushOnce();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(factoryRig.clients).toHaveLength(2);
    const client2 = factoryRig.clients[1]!;
    client2.fireConnect();
    client2.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(pushall({ gcode_state: 'IDLE' })),
    );

    expect(events.find((e) => e.kind === 'reconnected')).toBeDefined();
    await sub.stop();
  });

  it('emits unreachable on initial factory throw', async () => {
    factoryRig.failNext(new Error('ECONNREFUSED'));
    const sub = createBambuSubscriber({
      printerKind: 'bambu_x1c',
      mqttFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10],
    });
    await sub.start(makePrinter(), makeCredential(), (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('unreachable');
    await sub.stop();
  });

  it('rejects start when no credential provided', async () => {
    const sub = createBambuSubscriber({
      printerKind: 'bambu_x1c',
      mqttFactory: factoryRig.factory,
      setTimeout: timerRig.setTimer,
      clearTimeout: timerRig.clearTimer,
      reconnectBackoffMs: [10],
    });
    await sub.start(makePrinter(), null, (e) => events.push(e));
    // openTransport throws → base emits unreachable
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('unreachable');
    await sub.stop();
  });

  it('stop() is idempotent', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    factoryRig.clients[0]!.fireConnect();
    await sub.stop();
    await expect(sub.stop()).resolves.toBeUndefined();
    expect(sub.isConnected()).toBe(false);
  });

  it('does not reconnect after stop()', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    factoryRig.clients[0]!.fireConnect();
    await sub.stop();
    factoryRig.clients[0]!.fireClose();
    expect(timerRig.pending).toHaveLength(0);
    expect(factoryRig.calls).toHaveLength(1);
  });

  it('measuredConsumption is undefined on progress events even when AMS data present', async () => {
    const { sub, promise } = startSubscriber();
    await promise;
    const client = factoryRig.clients[0]!;
    client.fireConnect();
    client.fireMessage(
      'device/01ABCDEFGHIJKL/report',
      JSON.stringify(
        pushall({
          gcode_state: 'RUNNING',
          mc_percent: 50,
          subtask_name: 'foo.gcode',
          ams: { ams: [{ id: '0', tray: [{ id: '0', remain: 70 }] }] },
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('progress');
    expect(events[0]!.measuredConsumption).toBeUndefined();
    await sub.stop();
  });
});
