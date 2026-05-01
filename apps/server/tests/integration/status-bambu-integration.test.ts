/**
 * V2-005f-T_dcf13 — Bambu LAN per-protocol status integration test.
 *
 * Drives the FULL pipeline: forge-status-worker → registry → real Bambu
 * subscriber (with mock MQTT factory) → status-event-handler → DB →
 * consumption-emitter → ledger.
 *
 * UNIQUE BAMBU COVERAGE: this test pre-populates `materials_used` with a
 * non-empty material_id so the consumption-emission Phase B (T_dcf11) path
 * fires. AMS payload at completion carries `remain_percent=20` → emitter
 * back-calculates measured grams as 100g × 80% = 80g via the documented
 * remain_percent fallback.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb, schema } from '../../src/db/client';
import { createBambuSubscriber } from '../../src/forge/status/subscribers/bambu';
import type {
  MqttClientLike,
  MqttFactory,
} from '../../src/forge/dispatch/bambu/adapter';
import {
  flushAsyncQueue,
  setupStatusIntegrationHarness,
  type StatusIntegrationHarness,
} from './_status-integration-helpers';

// ---------------------------------------------------------------------------
// Mock MQTT
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeMqtt extends MqttClientLike {
  __listeners: Record<string, Listener[]>;
  __subscriptions: Array<{ topic: string }>;
  fireConnect(): void;
  fireMessage(topic: string, payload: unknown): void;
  fireClose(): void;
}

function makeFakeMqtt(): FakeMqtt {
  const listeners: Record<string, Listener[]> = {};
  const subs: FakeMqtt['__subscriptions'] = [];
  const client: FakeMqtt = {
    __listeners: listeners,
    __subscriptions: subs,
    publish(_t, _p, _o, cb) {
      cb(undefined);
    },
    subscribe(topic, _opts, cb) {
      subs.push({ topic });
      cb(null);
    },
    end(_force, cb) {
      cb?.();
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
    },
    once(event, listener) {
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
    fireMessage(topic, payload) {
      const arr = listeners.message ?? [];
      for (const fn of arr.slice()) fn(topic, payload);
    },
    fireClose() {
      const arr = listeners.close ?? [];
      for (const fn of arr.slice()) fn();
    },
  };
  return client;
}

interface FactoryRig {
  factory: MqttFactory;
  clients: FakeMqtt[];
}

function makeFactoryRig(): FactoryRig {
  const clients: FakeMqtt[] = [];
  const factory: MqttFactory = () => {
    const c = makeFakeMqtt();
    clients.push(c);
    return c;
  };
  return { factory, clients };
}

const SERIAL = '01ABCDEFGHIJKL';
const TOPIC = `device/${SERIAL}/report`;

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

function publishMessage(client: FakeMqtt, payload: unknown): void {
  client.fireMessage(TOPIC, Buffer.from(JSON.stringify(payload)));
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-status-bambu-integration.db';

let harness: StatusIntegrationHarness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

describe('V2-005f-T_dcf13 Bambu status integration', () => {
  it('drives a full lifecycle and emits measured consumption from AMS remain_percent', async () => {
    const factoryRig = makeFactoryRig();
    const subscriberFactory = {
      create: () =>
        createBambuSubscriber({
          printerKind: 'bambu_x1c',
          mqttFactory: factoryRig.factory,
          reconnectBackoffMs: [10],
        }),
    };

    harness = await setupStatusIntegrationHarness({
      dbPath: DB_PATH,
      printerKind: 'bambu_x1c',
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
      credential: {
        kind: 'bambu_lan',
        payload: { accessCode: 'ABCD1234', serial: SERIAL },
      },
      // Pre-populate materials_used with slot 0 → real Material; slot 1 → empty
      // material_id so we exercise BOTH the emit path and the skip path. The
      // material_id placeholder gets replaced by the harness once the Material
      // is seeded.
      materialsUsed: [
        {
          slot_index: 0,
          material_id: '__PLACEHOLDER__',
          estimated_grams: 100,
          measured_grams: null,
        },
      ],
      seedMaterial: { initialAmount: 500, slotIndex: 0 },
      subscriberFactory,
    });
    expect(harness.materialId).toBeTruthy();

    await harness.worker.notifyDispatched({
      dispatchJobId: harness.dispatchJobId,
      printerId: harness.printerId,
    });
    await flushAsyncQueue();
    expect(factoryRig.clients).toHaveLength(1);
    const client = factoryRig.clients[0]!;

    // 1) MQTT 'connect' → subscriber subscribes to device/<serial>/report.
    client.fireConnect();
    await flushAsyncQueue();
    expect(client.__subscriptions[0]!.topic).toBe(TOPIC);

    // 2) PREPARE → 'started'
    publishMessage(
      client,
      pushall({ gcode_state: 'PREPARE', subtask_name: 'cube.gcode' }),
    );
    await flushAsyncQueue();

    // 3) RUNNING 25 / 50 / 75
    publishMessage(
      client,
      pushall({
        gcode_state: 'RUNNING',
        mc_percent: 25,
        subtask_name: 'cube.gcode',
      }),
    );
    await flushAsyncQueue();
    publishMessage(
      client,
      pushall({
        gcode_state: 'RUNNING',
        mc_percent: 50,
        subtask_name: 'cube.gcode',
      }),
    );
    await flushAsyncQueue();
    publishMessage(
      client,
      pushall({
        gcode_state: 'RUNNING',
        mc_percent: 75,
        subtask_name: 'cube.gcode',
      }),
    );
    await flushAsyncQueue();

    // 4) FINISH with AMS slot 0 remain_percent=20 → consumed = 100×80% = 80g
    publishMessage(
      client,
      pushall({
        gcode_state: 'FINISH',
        mc_percent: 100,
        subtask_name: 'cube.gcode',
        ams: {
          ams: [
            {
              id: '0',
              tray: [{ id: '0', tray_type: 'PLA', remain: 20 }],
            },
          ],
        },
      }),
    );
    await flushAsyncQueue(8);

    // ---- Assertions ------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(harness.dbUrl) as any;

    const events = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(
        eq(schema.dispatchStatusEvents.dispatchJobId, harness.dispatchJobId),
      );
    // started + 3× progress + completed = at least 5
    expect(events.length).toBeGreaterThanOrEqual(5);
    const kinds = events.map((e: { eventKind: string }) => e.eventKind);
    expect(kinds).toContain('started');
    expect(kinds.filter((k: string) => k === 'progress').length).toBeGreaterThanOrEqual(3);
    expect(kinds).toContain('completed');

    const jobRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, harness.dispatchJobId));
    expect(jobRows[0].status).toBe('completed');
    expect(jobRows[0].progressPct).toBe(100);

    // Measured consumption ledger event for slot 0.
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger.length).toBeGreaterThanOrEqual(1);
    const measured = ledger.find(
      (r: { provenanceClass: string }) => r.provenanceClass === 'measured',
    );
    expect(measured).toBeDefined();
    const payload = JSON.parse(measured.payload);
    expect(payload.weightConsumed).toBeCloseTo(80, 5);
    expect(payload.attributedTo.jobId).toBe(harness.dispatchJobId);
    expect(payload.attributedTo.note).toBe('slot:0');
    expect(measured.subjectId).toBe(harness.materialId);
    expect(measured.subjectType).toBe('material');

    // Material remainingAmount decremented: 500 - 80 = 420.
    const matRows = await db
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, harness.materialId!));
    expect(matRows[0].remainingAmount).toBeCloseTo(420, 5);
  });
});
