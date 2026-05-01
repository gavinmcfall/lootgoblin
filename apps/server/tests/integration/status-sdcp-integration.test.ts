/**
 * V2-005f-T_dcf13 — SDCP per-protocol status integration test.
 *
 * Drives the FULL pipeline: forge-status-worker → registry → real SDCP
 * subscriber (with mock WebSocket factory) → status-event-handler → DB →
 * consumption-emitter → ledger.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb, schema } from '../../src/db/client';
import {
  createSdcpSubscriber,
  type WsClientLike,
  type WsFactory,
} from '../../src/forge/status/subscribers/sdcp';
import {
  flushAsyncQueue,
  setupStatusIntegrationHarness,
  type StatusIntegrationHarness,
} from './_status-integration-helpers';

// ---------------------------------------------------------------------------
// Mock WebSocket — drives SDCP frames
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeWs extends WsClientLike {
  __listeners: Record<string, Listener[]>;
  __sent: string[];
  fireOpen(): void;
  fireMessageJson(json: unknown): void;
  fireClose(): void;
}

function makeFakeWs(): FakeWs {
  const listeners: Record<string, Listener[]> = {};
  const ws: FakeWs = {
    __listeners: listeners,
    __sent: [],
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
    ping() {
      /* noop */
    },
    close() {
      /* noop */
    },
    fireOpen() {
      const arr = listeners.open ?? [];
      for (const fn of arr.slice()) fn();
    },
    fireMessageJson(json) {
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

const MAINBOARD_ID = 'AABBCCDDEEFF';
const STATUS_TOPIC = `sdcp/status/${MAINBOARD_ID}`;

function statusMsg(printInfo: Record<string, unknown>): unknown {
  return {
    Topic: STATUS_TOPIC,
    Status: { PrintInfo: printInfo },
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-status-sdcp-integration.db';

let harness: StatusIntegrationHarness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

describe('V2-005f-T_dcf13 SDCP status integration', () => {
  it('drives a full lifecycle (progress 25/50/75 → completed) end-to-end', async () => {
    const factoryRig = makeFactoryRig();
    const subscriberFactory = {
      create: () =>
        createSdcpSubscriber({
          printerKind: 'resin_sdcp',
          wsFactory: factoryRig.factory,
          reconnectBackoffMs: [10],
          // Long keepalive so it doesn't fire during the test.
          keepaliveIntervalMs: 30_000,
        }),
    };

    harness = await setupStatusIntegrationHarness({
      dbPath: DB_PATH,
      printerKind: 'resin_sdcp',
      connectionConfig: {
        ip: '192.168.1.66',
        mainboardId: MAINBOARD_ID,
        port: 3030,
        startPrint: true,
        startLayer: 0,
      },
      credential: {
        kind: 'sdcp_passcode',
        payload: { passcode: 'integration-test-pass' },
      },
      subscriberFactory,
    });

    await harness.worker.notifyDispatched({
      dispatchJobId: harness.dispatchJobId,
      printerId: harness.printerId,
    });
    await flushAsyncQueue();
    expect(factoryRig.sockets).toHaveLength(1);
    const ws = factoryRig.sockets[0]!;

    ws.fireOpen();
    await flushAsyncQueue();

    // SDCP marks 'connected' on first valid status message — Status=0 emits
    // no protocol event but sets connected=true.
    ws.fireMessageJson(statusMsg({ Status: 0 }));
    await flushAsyncQueue();

    // 1) progress 25% (CurrentLayer=25, TotalLayer=100)
    ws.fireMessageJson(
      statusMsg({
        Status: 1,
        CurrentLayer: 25,
        TotalLayer: 100,
        Filename: 'demo.ctb',
      }),
    );
    await flushAsyncQueue();

    // 2) progress 50%
    ws.fireMessageJson(
      statusMsg({
        Status: 1,
        CurrentLayer: 50,
        TotalLayer: 100,
        Filename: 'demo.ctb',
      }),
    );
    await flushAsyncQueue();

    // 3) progress 75%
    ws.fireMessageJson(
      statusMsg({
        Status: 1,
        CurrentLayer: 75,
        TotalLayer: 100,
        Filename: 'demo.ctb',
      }),
    );
    await flushAsyncQueue();

    // 4) completed (Status=2)
    ws.fireMessageJson(
      statusMsg({
        Status: 2,
        CurrentLayer: 100,
        TotalLayer: 100,
        Filename: 'demo.ctb',
      }),
    );
    await flushAsyncQueue();

    // ---- Assertions ------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(harness.dbUrl) as any;

    const events = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(
        eq(schema.dispatchStatusEvents.dispatchJobId, harness.dispatchJobId),
      );
    // 3× progress + completed = 4 minimum (Status=0 emits no event)
    expect(events.length).toBeGreaterThanOrEqual(4);
    const kinds = events.map((e: { eventKind: string }) => e.eventKind);
    expect(kinds.filter((k: string) => k === 'progress').length).toBeGreaterThanOrEqual(3);
    expect(kinds).toContain('completed');

    const jobRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, harness.dispatchJobId));
    expect(jobRows[0].status).toBe('completed');
    expect(jobRows[0].progressPct).toBe(100);
    expect(jobRows[0].lastStatusAt).not.toBeNull();

    // SDCP doesn't surface per-slot consumption → no measured ledger.
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(0);
  });
});
