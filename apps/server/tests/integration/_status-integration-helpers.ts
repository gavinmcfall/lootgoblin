/**
 * Shared helpers for V2-005f-T_dcf13 — per-protocol status integration tests.
 *
 * Each test file (Moonraker / OctoPrint / Bambu / SDCP / ChituNetwork) wires
 * the FULL status pipeline end-to-end using:
 *
 *   real `forge-status-worker` → real `subscriber registry` → real
 *   per-protocol subscriber (with mock transport) → real `status-event-handler`
 *   → real DB → real `consumption-emitter` (T_dcf11) → real ledger.
 *
 * The unit tests cover protocol mapping exhaustively (status-*-subscriber.test.ts);
 * these integration tests are spot-checks that prove the WIRING is right.
 *
 * Each test file builds its own mock transport (FakeWs / FakeMqtt / FakeTcp)
 * with the patterns established in the unit tests. The shared bits below are:
 *
 *   - `setupStatusIntegrationHarness` — DB + migrations + seed users/loot/
 *     printer/dispatch_job + wire the status worker to a real status-event-sink
 *     with the real consumption emitter, all using the test DB.
 *   - `flushAsyncQueue` — drains pending microtasks so subscriber → sink → DB
 *     chains settle before assertions.
 *   - Shared timer-rig + factory-rig types so each test file's transport doubles
 *     follow the same shape.
 */

import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';

import {
  runMigrations,
  getDb,
  resetDbCache,
  schema,
} from '../../src/db/client';
import { setCredential } from '../../src/forge/dispatch/credentials';
import { createMaterial } from '../../src/materials/lifecycle';
import {
  createSubscriberRegistry,
  resetDefaultSubscriberRegistry,
  type StatusSubscriberFactory,
  type StatusSubscriberRegistry,
} from '../../src/forge/status/registry';
import {
  createStatusEventBus,
  resetDefaultStatusEventBus,
  type StatusEventBus,
} from '../../src/forge/status/event-bus';
import { createStatusEventSink } from '../../src/forge/status/status-event-handler';
import { emitConsumptionForCompletion } from '../../src/forge/status/consumption-emitter';
import {
  createForgeStatusWorker,
  type ForgeStatusWorker,
} from '../../src/workers/forge-status-worker';
import type { MaterialsUsed } from '../../src/db/schema.forge';

// ---------------------------------------------------------------------------
// Shared timer rig (used by every protocol test that needs to advance time)
// ---------------------------------------------------------------------------

export interface TimerRig {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  pending: Array<{ cb: () => void; ms: number; handle: number }>;
  /** Flush the first matching timer. Returns true if one fired. */
  flushOnce(matcher?: (t: { ms: number }) => boolean): boolean;
}

export function makeTimerRig(): TimerRig {
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
    flushOnce(matcher) {
      const idx = matcher ? pending.findIndex(matcher) : 0;
      if (idx < 0 || idx >= pending.length) return false;
      const [t] = pending.splice(idx, 1);
      t!.cb();
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Async settle helper
// ---------------------------------------------------------------------------

/**
 * Drain pending microtasks + a single setImmediate tick. The status pipeline
 * is async at three layers: subscriber `onEvent` → sink correlate (await DB
 * read) → persist (await DB write) → emitConsumption (await handler). Without
 * a settle helper, assertions fire before the chain has reached the DB.
 */
export async function flushAsyncQueue(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface StatusIntegrationHarness {
  dbUrl: string;
  printerId: string;
  dispatchJobId: string;
  lootId: string;
  /**
   * Material id (or null when `materialsUsed` was not provided / an empty
   * material_id was used). Bambu test seeds a real Material so consumption
   * decrements actually take effect.
   */
  materialId: string | null;
  ownerId: string;
  worker: ForgeStatusWorker;
  bus: StatusEventBus;
  registry: StatusSubscriberRegistry;
  cleanup: () => Promise<void>;
}

export interface SetupStatusIntegrationHarnessArgs {
  /** SQLite file path — caller picks per-test to avoid collisions. */
  dbPath: string;
  /** `printers.kind` to seed (drives subscriber registry lookup). */
  printerKind: string;
  /** Connection config blob stored on `printers.connectionConfig`. */
  connectionConfig: Record<string, unknown>;
  /**
   * Pre-populate `dispatch_jobs.materials_used`. Use a non-empty material_id
   * to exercise the consumption emission path; leave empty (or omit) to test
   * the V2-005f-CF-1 default behaviour where the loadout map isn't wired yet.
   */
  materialsUsed?: MaterialsUsed | null;
  /** Seed a real Material row for at least one of the materialsUsed slots. */
  seedMaterial?: {
    initialAmount: number;
    /** Slot index (in materialsUsed) whose `material_id` will be patched to the new Material. */
    slotIndex: number;
  };
  /** Optional credential to seed (most subscribers need one). */
  credential?: {
    kind: string;
    payload: Record<string, unknown>;
  };
  /**
   * Subscriber factory injection — each test wires its own mock-transport
   * factory through here. Receives the `printers.kind` we registered.
   */
  subscriberFactory: StatusSubscriberFactory;
  /**
   * Override `setTimeout`/`clearTimeout` on the status worker. Tests that
   * exercise the teardown grace timer may want this; defaults to globals.
   */
  workerTimerRig?: TimerRig;
}

const TEST_SECRET = 'a'.repeat(32);

function uid(): string {
  return crypto.randomUUID();
}

export async function setupStatusIntegrationHarness(
  args: SetupStatusIntegrationHarnessArgs,
): Promise<StatusIntegrationHarness> {
  const dbPath = args.dbPath;
  const dbUrl = `file:${dbPath}`;

  // Wipe any leftover SQLite files so each test file starts clean.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      await fsp.unlink(`${dbPath}${suffix}`);
    } catch {
      /* ignore */
    }
  }

  process.env.DATABASE_URL = dbUrl;
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
  resetDbCache();
  resetDefaultSubscriberRegistry();
  resetDefaultStatusEventBus();

  await runMigrations(dbUrl);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = getDb(dbUrl) as any;

  // ---- Seed user / stash / collection / loot ------------------------------
  const ownerId = uid();
  await db.insert(schema.user).values({
    id: ownerId,
    name: 'Status Integration Test User',
    email: `${ownerId}@status-integration.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const stashRootId = uid();
  await db.insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: 'root',
    path: `/tmp/status-integration-${ownerId.slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const collectionId = uid();
  await db.insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: 'c-status',
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const lootId = uid();
  await db.insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'cube',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // ---- Seed Material (optional) -------------------------------------------
  let materialId: string | null = null;
  let materialsUsed: MaterialsUsed | null = args.materialsUsed ?? null;
  if (args.seedMaterial && materialsUsed) {
    const r = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        brand: 'TestBrand',
        subtype: 'PLA',
        colors: ['#112233'],
        colorPattern: 'solid',
        initialAmount: args.seedMaterial.initialAmount,
        unit: 'g',
      },
      { dbUrl },
    );
    if (!r.ok) throw new Error(`harness: createMaterial failed: ${r.reason}`);
    materialId = r.material.id;

    // Patch the requested slot's material_id to the freshly seeded id.
    const patched = materialsUsed.map((entry, idx) =>
      idx === args.seedMaterial!.slotIndex
        ? { ...entry, material_id: materialId! }
        : entry,
    );
    materialsUsed = patched;
  }

  // ---- Seed printer -------------------------------------------------------
  const printerId = uid();
  await db.insert(schema.printers).values({
    id: printerId,
    ownerId,
    kind: args.printerKind,
    name: `printer-${printerId.slice(0, 8)}`,
    connectionConfig: args.connectionConfig,
    active: true,
    createdAt: new Date(),
  });

  // ---- Seed credential ----------------------------------------------------
  if (args.credential) {
    setCredential({
      printerId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kind: args.credential.kind as any,
      payload: args.credential.payload,
      label: 'integration-test',
      dbUrl,
      secret: TEST_SECRET,
    });
  }

  // ---- Seed dispatch_job --------------------------------------------------
  const dispatchJobId = uid();
  await db.insert(schema.dispatchJobs).values({
    id: dispatchJobId,
    ownerId,
    lootId,
    targetKind: 'printer',
    targetId: printerId,
    status: 'dispatched',
    materialsUsed,
    createdAt: new Date(),
  });

  // ---- Build subscriber registry + register the test factory --------------
  const registry = createSubscriberRegistry();
  registry.register(args.printerKind, args.subscriberFactory);

  // ---- Build status event bus + sink + worker -----------------------------
  const bus = createStatusEventBus();

  // Forward declaration so the sink can call worker.notifyTerminal without
  // a circular reference (matches the production wiring in instrumentation.ts).
  // eslint-disable-next-line prefer-const
  let workerRef: ForgeStatusWorker;
  const sink = createStatusEventSink({
    dbUrl,
    deps: {
      notifyTerminal: (a) => workerRef.notifyTerminal(a),
      emitConsumption: async ({ dispatchJobId: jid, event }) => {
        await emitConsumptionForCompletion(
          { dispatchJobId: jid, event },
          { dbUrl },
        );
      },
      emitToBus: (id, event) => bus.emit(id, event),
    },
  });

  workerRef = createForgeStatusWorker({
    registry,
    dbUrl,
    setTimeout: args.workerTimerRig?.setTimer,
    clearTimeout: args.workerTimerRig?.clearTimer,
    onEvent: (printerIdArg, event) => {
      void sink(printerIdArg, event);
    },
  });

  return {
    dbUrl,
    printerId,
    dispatchJobId,
    lootId,
    materialId,
    ownerId,
    worker: workerRef,
    bus,
    registry,
    cleanup: async () => {
      try {
        await workerRef.stop();
      } catch {
        /* ignore */
      }
      registry.clear();
      resetDbCache();
    },
  };
}
