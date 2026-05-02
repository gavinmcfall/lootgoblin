/**
 * V2-005f-T_dcf13 — ChituNetwork per-protocol status integration test.
 *
 * Drives the FULL pipeline: forge-status-worker → registry → real
 * ChituNetwork subscriber (with mock TCP factory + injected timer rig) →
 * status-event-handler → DB → consumption-emitter → ledger.
 *
 * ChituNetwork uses an adaptive poll-based state machine instead of
 * push notifications, so the test drives `M27` replies through the mock
 * socket as the timer rig fires polls.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb, schema } from '../../src/db/client';
import {
  createChituNetworkSubscriber,
  type ChituNetworkSubscriberHandle,
} from '../../src/forge/status/subscribers/chitu-network';
import type {
  TcpSocketLike,
  TcpSocketFactory,
} from '../../src/forge/dispatch/chitu-network/commander';
import {
  flushAsyncQueue,
  makeTimerRig,
  setupStatusIntegrationHarness,
  type StatusIntegrationHarness,
  type TimerRig,
} from './_status-integration-helpers';

// ---------------------------------------------------------------------------
// Mock TCP socket
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeSocket extends TcpSocketLike {
  __listeners: Record<string, Listener[]>;
  __sent: string[];
  fireConnect(): void;
  fireData(data: Buffer | string): void;
  fireClose(): void;
}

function makeFakeSocket(): FakeSocket {
  const listeners: Record<string, Listener[]> = {};
  let connectCb: (() => void) | null = null;
  const sock: FakeSocket = {
    __listeners: listeners,
    __sent: [],
    connect(_port, _host, cb) {
      connectCb = cb ?? null;
    },
    write(data, cb) {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      sock.__sent.push(text);
      cb?.(undefined);
    },
    end() {
      /* noop */
    },
    destroy() {
      /* noop */
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
    },
    once(event, listener) {
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
    fireData(data) {
      const arr = listeners.data ?? [];
      for (const fn of arr.slice()) fn(data);
    },
    fireClose() {
      const arr = listeners.close ?? [];
      for (const fn of arr.slice()) fn();
    },
  };
  return sock;
}

interface FactoryRig {
  factory: TcpSocketFactory;
  sockets: FakeSocket[];
}

function makeTcpFactoryRig(): FactoryRig {
  const sockets: FakeSocket[] = [];
  const factory: TcpSocketFactory = () => {
    const sock = makeFakeSocket();
    sockets.push(sock);
    return sock;
  };
  return { factory, sockets };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-status-chitu-network-integration.db';

let harness: StatusIntegrationHarness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

describe('V2-005f-T_dcf13 ChituNetwork status integration', () => {
  it('drives a full lifecycle (started → progress 25/50/75 → completed) via timer-driven polls', async () => {
    const tcpRig = makeTcpFactoryRig();
    const subTimerRig = makeTimerRig();

    // Capture the subscriber handle so we can call notifyPrinting directly.
    let subscriberHandle: ChituNetworkSubscriberHandle | null = null;
    const subscriberFactory = {
      create: () => {
        const sub = createChituNetworkSubscriber({
          printerKind: 'chitu_network_phrozen_sonic_mighty_8k',
          tcpFactory: tcpRig.factory,
          setTimeout: subTimerRig.setTimer,
          clearTimeout: subTimerRig.clearTimer,
          reconnectBackoffMs: [10],
          m27TimeoutMs: 5_000,
        });
        subscriberHandle = sub;
        return sub;
      },
    };

    harness = await setupStatusIntegrationHarness({
      dbPath: DB_PATH,
      printerKind: 'chitu_network_phrozen_sonic_mighty_8k',
      connectionConfig: {
        ip: '192.168.1.42',
        port: 3000,
        startPrint: true,
        stageTimeoutMs: 60_000,
      },
      subscriberFactory,
    });

    // Notify dispatched — worker calls factory.create + subscriber.start.
    await harness.worker.notifyDispatched({
      dispatchJobId: harness.dispatchJobId,
      printerId: harness.printerId,
    });
    await flushAsyncQueue();
    expect(tcpRig.sockets).toHaveLength(1);
    const sock = tcpRig.sockets[0]!;
    sock.fireConnect();
    expect(subscriberHandle).not.toBeNull();

    // Force IDLE → PRINTING so the next poll uses 10s cadence.
    subscriberHandle!.notifyPrinting();

    // Helper: flush the active poll timer (priority match by `ms`),
    // wait for the M27 send, then deliver the reply.
    async function deliverM27(reply: string, pollMs: number): Promise<void> {
      expect(subTimerRig.flushOnce((t) => t.ms === pollMs)).toBe(true);
      await flushAsyncQueue();
      sock.fireData(reply.endsWith('\n') ? reply : reply + '\n');
      await flushAsyncQueue();
    }

    // 1) progress 25%
    await deliverM27('Print: 25000/100000', 10_000);
    // 2) progress 50%
    await deliverM27('Print: 50000/100000', 10_000);
    // 3) progress 75% (still PRINTING — threshold is 90%)
    await deliverM27('Print: 75000/100000', 10_000);
    // Bring it to NEAR_COMPLETION
    await deliverM27('Print: 92000/100000', 10_000);
    // Now NEAR_COMPLETION cadence is 2s; 'Not currently printing' →
    // JUST_FINISHED + completed event.
    await deliverM27('Not currently printing', 2_000);

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
    // 4× progress (25/50/75/92) + 1× completed = 5 minimum.
    expect(events.length).toBeGreaterThanOrEqual(5);
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

    // ChituNetwork doesn't surface per-slot consumption.
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(0);

    // Reference TimerRig type to avoid unused-export complaints when the
    // helper is imported only for the timer plumbing.
    const _r: TimerRig = subTimerRig;
    expect(_r.pending.length).toBeGreaterThanOrEqual(0);
  });
});
