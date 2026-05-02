/**
 * V2-005f-T_dcf13 — Moonraker per-protocol status integration test.
 *
 * Drives the FULL pipeline:
 *   forge-status-worker → subscriber registry → real Moonraker subscriber
 *   (with mock WebSocket factory) → status-event-handler → DB
 *   → consumption-emitter → ledger.
 *
 * The unit tests cover Moonraker mapping exhaustively
 * (status-moonraker-subscriber.test.ts). This is the wiring spot-check.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb, schema } from '../../src/db/client';
import { createMoonrakerSubscriber } from '../../src/forge/status/subscribers/moonraker';
import type {
  WsClientLike,
  WsFactory,
} from '../../src/forge/status/subscribers/_ws-client';
import {
  flushAsyncQueue,
  setupStatusIntegrationHarness,
  type StatusIntegrationHarness,
} from './_status-integration-helpers';

// ---------------------------------------------------------------------------
// Mock WebSocket — drives Moonraker JSON-RPC frames
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeWs extends WsClientLike {
  __listeners: Record<string, Listener[]>;
  __sent: string[];
  __closed: boolean;
  fireOpen(): void;
  fireMessage(json: unknown): void;
  fireClose(): void;
}

function makeFakeWs(): FakeWs {
  const listeners: Record<string, Listener[]> = {};
  const ws: FakeWs = {
    __listeners: listeners,
    __sent: [],
    __closed: false,
    readyState: 0,
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return ws;
    },
    off(event, listener) {
      const arr = listeners[event];
      if (arr) {
        const idx = arr.indexOf(listener);
        if (idx >= 0) arr.splice(idx, 1);
      }
      return ws;
    },
    send(data, cb) {
      ws.__sent.push(data);
      cb?.(undefined);
    },
    close() {
      ws.__closed = true;
    },
    fireOpen() {
      const arr = listeners.open ?? [];
      for (const fn of arr.slice()) fn();
    },
    fireMessage(json) {
      const data = JSON.stringify(json);
      const arr = listeners.message ?? [];
      for (const fn of arr.slice()) fn(data);
    },
    fireClose() {
      const arr = listeners.close ?? [];
      for (const fn of arr.slice()) fn();
    },
  };
  return ws;
}

interface FactoryRig {
  factory: WsFactory;
  sockets: FakeWs[];
}

function makeFactoryRig(): FactoryRig {
  const sockets: FakeWs[] = [];
  const factory: WsFactory = () => {
    const ws = makeFakeWs();
    sockets.push(ws);
    return ws;
  };
  return { factory, sockets };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-status-moonraker-integration.db';

let harness: StatusIntegrationHarness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

describe('V2-005f-T_dcf13 Moonraker status integration', () => {
  it('drives a full lifecycle (started → progress 25/50/75 → completed) end-to-end', async () => {
    const factoryRig = makeFactoryRig();
    const subscriberFactory = {
      create: () =>
        createMoonrakerSubscriber({
          wsFactory: factoryRig.factory,
          reconnectBackoffMs: [10],
        }),
    };

    harness = await setupStatusIntegrationHarness({
      dbPath: DB_PATH,
      printerKind: 'fdm_klipper',
      connectionConfig: {
        host: '192.168.1.50',
        port: 7125,
        scheme: 'http',
        requiresAuth: true,
        startPrint: true,
      },
      credential: {
        kind: 'moonraker_api_key',
        payload: { apiKey: 'integration-test-key' },
      },
      subscriberFactory,
    });

    // Start the subscriber by notifying dispatch.
    await harness.worker.notifyDispatched({
      dispatchJobId: harness.dispatchJobId,
      printerId: harness.printerId,
    });
    expect(harness.worker.isWatching(harness.printerId)).toBe(true);

    // Subscribe is async (start() awaits the WS factory). Wait for the socket.
    await flushAsyncQueue();
    expect(factoryRig.sockets).toHaveLength(1);
    const ws = factoryRig.sockets[0]!;

    // 1) Open + initial subscribe-reply (id=1) — marks subscriber 'connected'.
    ws.fireOpen();
    ws.fireMessage({
      jsonrpc: '2.0',
      id: 1,
      result: {
        status: { print_stats: { state: 'standby', filename: '' } },
        eventtime: 0,
      },
    });
    await flushAsyncQueue();

    // 2) progress 25%
    ws.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [
        {
          print_stats: { state: 'printing', filename: 'cube.gcode' },
          display_status: { progress: 0.25 },
        },
        100,
      ],
    });
    await flushAsyncQueue();

    // 3) progress 50%
    ws.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [
        {
          print_stats: { state: 'printing', filename: 'cube.gcode' },
          display_status: { progress: 0.5 },
        },
        200,
      ],
    });
    await flushAsyncQueue();

    // 4) progress 75%
    ws.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [
        {
          print_stats: { state: 'printing', filename: 'cube.gcode' },
          display_status: { progress: 0.75 },
        },
        300,
      ],
    });
    await flushAsyncQueue();

    // 5) completed (notify_history_changed action=finished status=completed)
    ws.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: {
            filename: 'cube.gcode',
            status: 'completed',
            filament_used: 1500,
            total_duration: 3600,
            print_duration: 3550,
          },
        },
      ],
    });
    await flushAsyncQueue();

    // ---- Assertions ------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(harness.dbUrl) as any;

    // dispatch_status_events: 3× progress + 1× completed = 4 rows minimum.
    // (subscribe-reply only emits a 'reconnected' event when wasConnected=true,
    // which is false on first connect — so no event for that.)
    const events = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(
        eq(schema.dispatchStatusEvents.dispatchJobId, harness.dispatchJobId),
      );
    expect(events.length).toBeGreaterThanOrEqual(4);
    const kinds = events.map((e: { eventKind: string }) => e.eventKind);
    expect(kinds.filter((k: string) => k === 'progress').length).toBeGreaterThanOrEqual(3);
    expect(kinds).toContain('completed');

    // dispatch_jobs.status transitioned to 'completed', progress_pct = 100.
    const jobRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, harness.dispatchJobId));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0].status).toBe('completed');
    expect(jobRows[0].progressPct).toBe(100);
    expect(jobRows[0].lastStatusAt).not.toBeNull();
    expect(jobRows[0].completedAt).not.toBeNull();

    // No measuredConsumption from Moonraker → no measured ledger entries.
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(0);
  });
});
