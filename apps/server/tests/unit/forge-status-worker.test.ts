/**
 * Unit tests — forge-status-worker — V2-005f-T_dcf9.
 *
 * Coverage:
 *   1.  Lazy-start single dispatch — first notifyDispatched calls
 *       factory.create + subscriber.start exactly once
 *   2.  No factory registered for printer.kind → no subscription, warn-only
 *   3.  Second dispatch on same printer reuses the existing subscriber
 *   4.  notifyTerminal on a non-last job removes it from activeJobs without
 *       scheduling a teardown
 *   5.  notifyTerminal on the last job schedules the grace timer (not yet
 *       fired)
 *   6.  Teardown timer fires after the grace window → subscriber.stop +
 *       isWatching false
 *   7.  New dispatch arriving inside the grace window cancels the teardown
 *   8.  Multi-printer: dispatches across two printers create two subs
 *   9.  recover() boot-resilience seeds two printers from dispatched rows
 *  10.  stop() tears down every active subscription
 *  11.  onEvent forwarding: subscriber emit → worker onEvent(printerId, event)
 *  12.  notifyDispatched on unknown printer → warn-only, no-op
 *  13.  Missing credential row: subscriber.start still called, credential=null
 *  14.  isWatching tracks subscription state across lifecycle
 *
 * The DB-touching tests (recover, missing-printer, missing-cred) use a
 * scoped on-disk SQLite + the standard `runMigrations` bootstrap pattern.
 * The pure lifecycle tests (1–8, 10, 11, 14) inject a fake registry and
 * skip the DB layer entirely by going through `notifyDispatched` for a
 * pre-seeded printer row.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  runMigrations,
  resetDbCache,
  getDb,
} from '../../src/db/client';
import * as schema from '../../src/db/schema';
import {
  createSubscriberRegistry,
  type StatusSubscriberFactory,
  type StatusSubscriberRegistry,
} from '../../src/forge/status/registry';
import type {
  PrinterRecord,
  StatusEvent,
  StatusSubscriber,
  StatusSourceProtocol,
} from '../../src/forge/status/types';
import { createForgeStatusWorker } from '../../src/workers/forge-status-worker';

const DB_PATH = '/tmp/lootgoblin-forge-status-worker.db';
const DB_URL = `file:${DB_PATH}`;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  // T_da6 readers (getCredential) demand LOOTGOBLIN_SECRET; tests don't set
  // any actual credentials, but resolveSecret throws even on read paths
  // before checking row existence. Provide a 32-char dummy.
  process.env.LOOTGOBLIN_SECRET ??= 'a'.repeat(32);
  await runMigrations(DB_URL);
}, 30_000);

beforeEach(() => {
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
});

afterEach(async () => {
  // Tear down any orphaned subs the test left behind (no shared singleton —
  // each test creates its own worker — so this is just defensive).
  const db = getDb(DB_URL) as ReturnType<typeof getDb>;
  await (db as any).delete(schema.dispatchJobs);
  await (db as any).delete(schema.printers);
  await (db as any).delete(schema.loot);
  await (db as any).delete(schema.collections);
  await (db as any).delete(schema.stashRoots);
  await (db as any).delete(schema.user);
});

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

class FakeSubscriber implements StatusSubscriber {
  protocol: StatusSourceProtocol = 'moonraker';
  printerKind: string;
  startCalls = 0;
  stopCalls = 0;
  emitTo: ((e: StatusEvent) => void) | null = null;
  capturedPrinter: PrinterRecord | null = null;
  capturedCredential: unknown = undefined;
  shouldThrowOnStart = false;

  constructor(kind: string) {
    this.printerKind = kind;
  }

  async start(
    printer: PrinterRecord,
    credential: unknown,
    onEvent: (event: StatusEvent) => void,
  ): Promise<void> {
    if (this.shouldThrowOnStart) {
      throw new Error('start boom');
    }
    this.startCalls += 1;
    this.capturedPrinter = printer;
    this.capturedCredential = credential;
    this.emitTo = onEvent;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.emitTo = null;
  }

  isConnected(): boolean {
    return this.emitTo !== null;
  }
}

interface InstrumentedFactory extends StatusSubscriberFactory {
  /** All subscribers vended by this factory, in creation order. */
  vended: FakeSubscriber[];
}

function makeFactory(
  protocol: StatusSourceProtocol = 'moonraker',
): InstrumentedFactory {
  const vended: FakeSubscriber[] = [];
  return {
    vended,
    create(kind: string) {
      const s = new FakeSubscriber(kind);
      s.protocol = protocol;
      vended.push(s);
      return s;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake-timer harness (no vi.useFakeTimers — we inject setTimeout/clearTimeout
// into the worker so we can advance the clock deterministically)
// ---------------------------------------------------------------------------

interface TimerHarness {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  /** Move virtual clock forward; fires any timers whose deadline has passed. */
  advance(ms: number): Promise<void>;
  /** How many timers are currently pending. */
  pending(): number;
}

function makeTimerHarness(): TimerHarness {
  let now = 0;
  let nextId = 1;
  const timers = new Map<
    number,
    { deadline: number; cb: () => void; cancelled: boolean }
  >();

  return {
    setTimeout(cb, ms) {
      const id = nextId++;
      timers.set(id, { deadline: now + ms, cb, cancelled: false });
      return id;
    },
    clearTimeout(handle) {
      const id = handle as number;
      const t = timers.get(id);
      if (t) t.cancelled = true;
      timers.delete(id);
    },
    async advance(ms: number) {
      now += ms;
      // Find ready timers, sort by deadline, fire in order.
      const ready = Array.from(timers.entries())
        .filter(([, t]) => !t.cancelled && t.deadline <= now)
        .sort((a, b) => a[1].deadline - b[1].deadline);
      for (const [id, t] of ready) {
        timers.delete(id);
        t.cb();
        // Yield to any microtasks the timer scheduled (subscriber.stop is
        // async; teardown awaits it).
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    pending() {
      return Array.from(timers.values()).filter((t) => !t.cancelled).length;
    },
  };
}

// ---------------------------------------------------------------------------
// DB seeders (used by recover / missing-printer / missing-credential cases)
// ---------------------------------------------------------------------------

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

interface SeedPrinter {
  ownerId: string;
  printerId: string;
}

async function seedUser(): Promise<string> {
  const db = getDb(DB_URL) as any;
  const id = uid('u');
  await db.insert(schema.user).values({
    id,
    name: 'forge-status test user',
    email: `${id}@status-worker.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(
  ownerId: string,
  kind: string = 'fdm_klipper',
): Promise<string> {
  const db = getDb(DB_URL) as any;
  const id = uid('p');
  await db.insert(schema.printers).values({
    id,
    ownerId,
    kind,
    name: `printer-${id.slice(0, 6)}`,
    connectionConfig: { url: 'http://1.2.3.4:7125' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedDispatchJobOnPrinter(args: {
  ownerId: string;
  printerId: string;
  status?: 'claimable' | 'claimed' | 'dispatched' | 'completed' | 'failed';
}): Promise<string> {
  const db = getDb(DB_URL) as any;
  const userId = args.ownerId;

  // Minimal collection / loot graph so the FK on dispatch_jobs.loot_id holds.
  const rootPath = `/tmp/lg-status-${randomUUID().slice(0, 8)}`;
  const rootId = uid('r');
  const collectionId = uid('c');
  const lootId = uid('l');
  const jobId = uid('j');

  await db.insert(schema.stashRoots).values({
    id: rootId,
    ownerId: userId,
    name: 'root',
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.collections).values({
    id: collectionId,
    ownerId: userId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'cube',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.dispatchJobs).values({
    id: jobId,
    ownerId: userId,
    lootId,
    targetKind: 'printer',
    targetId: args.printerId,
    status: args.status ?? 'dispatched',
    createdAt: new Date(),
  });
  return jobId;
}

async function setupPrinter(): Promise<SeedPrinter> {
  const ownerId = await seedUser();
  const printerId = await seedPrinter(ownerId);
  return { ownerId, printerId };
}

// ---------------------------------------------------------------------------
// Convenience: registry seeded with one factory for `fdm_klipper`
// ---------------------------------------------------------------------------

function makeRegistry(): {
  registry: StatusSubscriberRegistry;
  factory: InstrumentedFactory;
} {
  const registry = createSubscriberRegistry();
  const factory = makeFactory();
  registry.register('fdm_klipper', factory);
  return { registry, factory };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('forge-status-worker — V2-005f-T_dcf9', () => {
  it('1. lazy-start single dispatch creates and starts exactly one subscriber', async () => {
    const { registry, factory } = makeRegistry();
    const { printerId } = await setupPrinter();
    const worker = createForgeStatusWorker({ registry, dbUrl: DB_URL });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });

    expect(factory.vended).toHaveLength(1);
    expect(factory.vended[0]!.startCalls).toBe(1);
    expect(worker.activeCount()).toBe(1);
    expect(worker.isWatching(printerId)).toBe(true);
  });

  it('2. unknown printer.kind → no factory → warn-only, no subscription', async () => {
    const registry = createSubscriberRegistry(); // empty
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId, 'unknown_kind');
    const worker = createForgeStatusWorker({ registry, dbUrl: DB_URL });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });

    expect(worker.activeCount()).toBe(0);
    expect(worker.isWatching(printerId)).toBe(false);
  });

  it('3. second dispatch on same printer reuses subscriber, no second start', async () => {
    const { registry, factory } = makeRegistry();
    const { printerId } = await setupPrinter();
    const worker = createForgeStatusWorker({ registry, dbUrl: DB_URL });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });
    await worker.notifyDispatched({ dispatchJobId: 'j2', printerId });

    expect(factory.vended).toHaveLength(1);
    expect(factory.vended[0]!.startCalls).toBe(1);
    expect(worker.activeCount()).toBe(1);
  });

  it('4. notifyTerminal on a non-last job leaves the subscription up with no teardown timer', async () => {
    const { registry } = makeRegistry();
    const { printerId } = await setupPrinter();
    const timers = makeTimerHarness();
    const worker = createForgeStatusWorker({
      registry,
      dbUrl: DB_URL,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });
    await worker.notifyDispatched({ dispatchJobId: 'j2', printerId });
    await worker.notifyTerminal({ dispatchJobId: 'j1', printerId });

    expect(worker.activeCount()).toBe(1);
    expect(timers.pending()).toBe(0);
  });

  it('5. notifyTerminal on the last job schedules a teardown timer (not yet fired)', async () => {
    const { registry, factory } = makeRegistry();
    const { printerId } = await setupPrinter();
    const timers = makeTimerHarness();
    const worker = createForgeStatusWorker({
      registry,
      dbUrl: DB_URL,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });
    await worker.notifyTerminal({ dispatchJobId: 'j1', printerId });

    expect(timers.pending()).toBe(1);
    expect(factory.vended[0]!.stopCalls).toBe(0);
    expect(worker.activeCount()).toBe(1);
  });

  it('6. teardown timer fires after the grace window → subscriber.stop + isWatching false', async () => {
    const { registry, factory } = makeRegistry();
    const { printerId } = await setupPrinter();
    const timers = makeTimerHarness();
    const worker = createForgeStatusWorker({
      registry,
      dbUrl: DB_URL,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      teardownGraceMs: 30_000,
    });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });
    await worker.notifyTerminal({ dispatchJobId: 'j1', printerId });
    await timers.advance(30_000);

    expect(factory.vended[0]!.stopCalls).toBe(1);
    expect(worker.activeCount()).toBe(0);
    expect(worker.isWatching(printerId)).toBe(false);
  });

  it('7. new dispatch during the grace window cancels the teardown', async () => {
    const { registry, factory } = makeRegistry();
    const { printerId } = await setupPrinter();
    const timers = makeTimerHarness();
    const worker = createForgeStatusWorker({
      registry,
      dbUrl: DB_URL,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      teardownGraceMs: 30_000,
    });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });
    await worker.notifyTerminal({ dispatchJobId: 'j1', printerId });
    expect(timers.pending()).toBe(1);

    await timers.advance(15_000); // halfway through the grace
    await worker.notifyDispatched({ dispatchJobId: 'j2', printerId });

    expect(timers.pending()).toBe(0);
    // Push past the original grace deadline — nothing should fire.
    await timers.advance(30_000);

    expect(factory.vended[0]!.stopCalls).toBe(0);
    expect(factory.vended).toHaveLength(1); // no new subscriber created
    expect(worker.activeCount()).toBe(1);
  });

  it('8. dispatches across two printers create two distinct subscribers', async () => {
    const { registry, factory } = makeRegistry();
    const ownerId = await seedUser();
    const p1 = await seedPrinter(ownerId);
    const p2 = await seedPrinter(ownerId);
    const worker = createForgeStatusWorker({ registry, dbUrl: DB_URL });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId: p1 });
    await worker.notifyDispatched({ dispatchJobId: 'j2', printerId: p2 });

    expect(factory.vended).toHaveLength(2);
    expect(worker.activeCount()).toBe(2);
    expect(worker.isWatching(p1)).toBe(true);
    expect(worker.isWatching(p2)).toBe(true);
  });

  it('9. recover() boot-resilience: 3 dispatched jobs across 2 printers → 2 subscribers', async () => {
    const { registry, factory } = makeRegistry();
    const ownerId = await seedUser();
    const p1 = await seedPrinter(ownerId);
    const p2 = await seedPrinter(ownerId);
    // 2 dispatched jobs on p1, 1 on p2.
    await seedDispatchJobOnPrinter({ ownerId, printerId: p1 });
    await seedDispatchJobOnPrinter({ ownerId, printerId: p1 });
    await seedDispatchJobOnPrinter({ ownerId, printerId: p2 });
    // Plus one already-completed job on p1 — recover must NOT pick it up.
    await seedDispatchJobOnPrinter({
      ownerId,
      printerId: p1,
      status: 'completed',
    });

    const worker = createForgeStatusWorker({ registry, dbUrl: DB_URL });
    await worker.recover();

    expect(factory.vended).toHaveLength(2);
    expect(worker.activeCount()).toBe(2);
    expect(worker.isWatching(p1)).toBe(true);
    expect(worker.isWatching(p2)).toBe(true);
  });

  it('10. stop() tears down every active subscription', async () => {
    const { registry, factory } = makeRegistry();
    const ownerId = await seedUser();
    const p1 = await seedPrinter(ownerId);
    const p2 = await seedPrinter(ownerId);
    const p3 = await seedPrinter(ownerId);
    const worker = createForgeStatusWorker({ registry, dbUrl: DB_URL });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId: p1 });
    await worker.notifyDispatched({ dispatchJobId: 'j2', printerId: p2 });
    await worker.notifyDispatched({ dispatchJobId: 'j3', printerId: p3 });
    expect(worker.activeCount()).toBe(3);

    await worker.stop();

    expect(worker.activeCount()).toBe(0);
    expect(factory.vended.map((s) => s.stopCalls)).toEqual([1, 1, 1]);
  });

  it('11. onEvent forwarding: subscriber emits → worker invokes onEvent(printerId, event)', async () => {
    const { registry, factory } = makeRegistry();
    const { printerId } = await setupPrinter();
    const seen: Array<{ printerId: string; event: StatusEvent }> = [];
    const worker = createForgeStatusWorker({
      registry,
      dbUrl: DB_URL,
      onEvent: (pId, ev) => {
        seen.push({ printerId: pId, event: ev });
      },
    });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });

    const sub = factory.vended[0]!;
    expect(sub.emitTo).not.toBeNull();
    const ev: StatusEvent = {
      kind: 'progress',
      remoteJobRef: 'cube.gcode',
      progressPct: 42,
      rawPayload: { foo: 'bar' },
      occurredAt: new Date('2026-05-01T00:00:00Z'),
    };
    sub.emitTo!(ev);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.printerId).toBe(printerId);
    expect(seen[0]!.event).toBe(ev);
  });

  it('12. notifyDispatched on unknown printerId → no-op + warn', async () => {
    const { registry, factory } = makeRegistry();
    const worker = createForgeStatusWorker({ registry, dbUrl: DB_URL });

    await worker.notifyDispatched({
      dispatchJobId: 'jX',
      printerId: 'does-not-exist',
    });

    expect(factory.vended).toHaveLength(0);
    expect(worker.activeCount()).toBe(0);
  });

  it('13. missing credential row → subscriber.start still called with credential=null', async () => {
    const { registry, factory } = makeRegistry();
    // Printer exists, but no forge_target_credentials row → getCredential() returns null.
    const { printerId } = await setupPrinter();
    const worker = createForgeStatusWorker({ registry, dbUrl: DB_URL });

    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });

    expect(factory.vended[0]!.startCalls).toBe(1);
    expect(factory.vended[0]!.capturedCredential).toBeNull();
  });

  it('14. isWatching reflects subscription state across the full lifecycle', async () => {
    const { registry } = makeRegistry();
    const { printerId } = await setupPrinter();
    const timers = makeTimerHarness();
    const worker = createForgeStatusWorker({
      registry,
      dbUrl: DB_URL,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      teardownGraceMs: 1_000,
    });

    expect(worker.isWatching(printerId)).toBe(false);
    await worker.notifyDispatched({ dispatchJobId: 'j1', printerId });
    expect(worker.isWatching(printerId)).toBe(true);
    await worker.notifyTerminal({ dispatchJobId: 'j1', printerId });
    // Still watching until the grace timer fires.
    expect(worker.isWatching(printerId)).toBe(true);
    await timers.advance(1_000);
    expect(worker.isWatching(printerId)).toBe(false);
  });
});
