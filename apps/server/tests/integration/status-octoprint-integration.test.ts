/**
 * V2-005f-T_dcf13 — OctoPrint per-protocol status integration test.
 *
 * Drives the FULL pipeline: forge-status-worker → registry → real OctoPrint
 * subscriber (with mock SockJS WebSocket + mock HTTP login client) →
 * status-event-handler → DB → consumption-emitter → ledger.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb, schema } from '../../src/db/client';
import { createOctoprintSubscriber } from '../../src/forge/status/subscribers/octoprint';
import type {
  WsClientLike,
  WsFactory,
} from '../../src/forge/status/subscribers/_ws-client';
import type { HttpClient } from '../../src/forge/dispatch/handler';
import {
  flushAsyncQueue,
  setupStatusIntegrationHarness,
  type StatusIntegrationHarness,
} from './_status-integration-helpers';

// ---------------------------------------------------------------------------
// Mock WebSocket — drives SockJS-framed messages
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeWs extends WsClientLike {
  __listeners: Record<string, Listener[]>;
  __sent: string[];
  fireOpen(): void;
  fireRawMessage(text: string): void;
  fireArrayFrame(messages: unknown[]): void;
  fireOpenFrame(): void;
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
    close() {
      /* noop */
    },
    fireOpen() {
      const arr = listeners.open ?? [];
      for (const fn of arr.slice()) fn();
    },
    fireRawMessage(text) {
      const arr = listeners.message ?? [];
      for (const fn of arr.slice()) fn(text);
    },
    fireArrayFrame(messages) {
      const encoded = messages.map((m) =>
        typeof m === 'string' ? m : JSON.stringify(m),
      );
      ws.fireRawMessage('a' + JSON.stringify(encoded));
    },
    fireOpenFrame() {
      ws.fireRawMessage('o');
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

function makeHttpClient(): HttpClient {
  return {
    fetch: async () =>
      new Response(JSON.stringify({ name: 'octouser', session: 'sess-int' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-status-octoprint-integration.db';

let harness: StatusIntegrationHarness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

describe('V2-005f-T_dcf13 OctoPrint status integration', () => {
  it('drives a full lifecycle (started → progress 25/50/75 → completed) end-to-end', async () => {
    const factoryRig = makeFactoryRig();
    const subscriberFactory = {
      create: () =>
        createOctoprintSubscriber({
          wsFactory: factoryRig.factory,
          httpClient: makeHttpClient(),
          reconnectBackoffMs: [10],
        }),
    };

    harness = await setupStatusIntegrationHarness({
      dbPath: DB_PATH,
      printerKind: 'fdm_octoprint',
      connectionConfig: {
        host: '192.168.1.51',
        port: 80,
        scheme: 'http',
        apiPath: '/api',
        requiresAuth: true,
        select: true,
        startPrint: true,
      },
      credential: {
        kind: 'octoprint_api_key',
        payload: { apiKey: 'integration-test-key' },
      },
      subscriberFactory,
    });

    await harness.worker.notifyDispatched({
      dispatchJobId: harness.dispatchJobId,
      printerId: harness.printerId,
    });
    expect(harness.worker.isWatching(harness.printerId)).toBe(true);

    // Wait for HTTP login + WS open.
    await flushAsyncQueue();
    expect(factoryRig.sockets).toHaveLength(1);
    const ws = factoryRig.sockets[0]!;

    // 1) o-frame opens SockJS; auth message gets sent.
    ws.fireOpenFrame();
    await flushAsyncQueue();

    // 2) PrintStarted event fires the 'started' StatusEvent.
    ws.fireArrayFrame([
      {
        event: { type: 'PrintStarted', payload: { name: 'cube.gcode' } },
      },
    ]);
    await flushAsyncQueue();

    // 3) progress 25 / 50 / 75 — current.state.text='Printing'.
    ws.fireArrayFrame([
      {
        current: {
          state: { text: 'Printing' },
          progress: { completion: 25 },
          job: { file: { name: 'cube.gcode' } },
        },
      },
    ]);
    await flushAsyncQueue();
    ws.fireArrayFrame([
      {
        current: {
          state: { text: 'Printing' },
          progress: { completion: 50 },
          job: { file: { name: 'cube.gcode' } },
        },
      },
    ]);
    await flushAsyncQueue();
    ws.fireArrayFrame([
      {
        current: {
          state: { text: 'Printing' },
          progress: { completion: 75 },
          job: { file: { name: 'cube.gcode' } },
        },
      },
    ]);
    await flushAsyncQueue();

    // 4) PrintDone — completed.
    ws.fireArrayFrame([
      {
        event: {
          type: 'PrintDone',
          payload: { name: 'cube.gcode' },
        },
      },
    ]);
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
    expect(jobRows[0].lastStatusAt).not.toBeNull();

    // No measuredConsumption from OctoPrint → no measured ledger entries.
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(0);
  });
});
