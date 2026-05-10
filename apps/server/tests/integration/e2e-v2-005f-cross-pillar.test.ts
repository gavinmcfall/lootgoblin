/**
 * V2-005f-T_dcf14 — Cross-pillar end-to-end test.
 *
 * Single, comprehensive integration test that exercises the full lootgoblin
 * pipeline across every major boundary V2-005f touches:
 *
 *   1. Scavenger ingest      (V2-003-T2 — represented by direct Loot+LootFile
 *                              seeding, since V2-003's own e2e suite covers
 *                              the URL → adapter → pipeline → Stash arc and
 *                              this test's job is to prove V2-005f wiring).
 *   2. Stash placement       (loot_files row pointing at a real on-disk gcode
 *                              file — provides the realistic shape that the
 *                              slicer-estimate extractor would consume).
 *   3. V2-005c slicer        (a real PrusaSlicer-style gcode artifact written
 *                              with embedded `; filament used [g] = ...`
 *                              tags so the artifact looks like a slicer output
 *                              even though we don't drive the slicer itself).
 *   4. V2-005d-a dispatcher  (Moonraker — mocked: stub DispatchHandler whose
 *                              dispatch() just returns ok=true; we drive the
 *                              dispatch_job state-machine directly via
 *                              markDispatched after the dispatch wiring is
 *                              verified).
 *   5. V2-005f status events (mocked StatusSubscriber that captures onEvent
 *                              and lets the test fire StatusEvents directly,
 *                              avoiding protocol-specific transport mocks
 *                              while still exercising the full real
 *                              status-event-handler → DB → emitConsumption
 *                              chain).
 *   6. V2-005f consumption   (real consumption-emitter from T_dcf11; on the
 *                              winning `dispatched → completed` transition,
 *                              fires V2-007a-T8 handleMaterialConsumed for
 *                              every slot with measuredConsumption).
 *   7. V2-007a Ledger        (real handleMaterialConsumed persists a
 *                              `material.consumed` ledger row with
 *                              `provenance_class='measured'` and decrements
 *                              `materials.remaining_amount`).
 *   8. Final assertions      (the wiring is sound — see asserts below).
 *
 * ## Why we don't drive the real ingest pipeline or the real Moonraker WS
 *
 * The plan calls out pragmatic simplifications: V2-003 already proves URL →
 * Loot end-to-end (`e2e-full-chain-verification.test.ts` and friends), and
 * the per-protocol Moonraker subscriber WS plumbing is exhaustively covered
 * by `status-moonraker-integration.test.ts` (T_dcf13). This test's *unique*
 * value is proving that, given a Loot exists and given a printer's status
 * subscriber emits StatusEvents, the V2-005f pipeline correctly drives the
 * dispatch_job to completion AND threads through to the V2-007a ledger.
 *
 * ## Phase A vs Phase B simplification
 *
 * V2-005f-CF-1 is documented: material loadout tracking is not yet wired,
 * so material_id in materials_used is `''` by default and Phase A's
 * estimated emission is a no-op. To exercise the FULL flow including
 * consumption emission, this test pre-populates dispatch_jobs.materials_used
 * with a real material_id (the operator-configures-loadout case).
 *
 * The plan note: "do (A) — pre-populate materials_used with a valid
 * material_id so the test can exercise the FULL flow including consumption
 * emission. The test is a 'if material loadout is configured, full flow
 * works' assertion."
 */

import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  vi,
  type MockInstance,
} from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';

import {
  runMigrations,
  getDb,
  resetDbCache,
  schema,
} from '../../src/db/client';
import { createMaterial, loadInPrinter } from '../../src/materials/lifecycle';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';
import { createDispatchJob } from '../../src/forge/dispatch-jobs';
import { runOneClaimTick } from '../../src/workers/forge-claim-worker';
import {
  createSubscriberRegistry,
  resetDefaultSubscriberRegistry,
  type StatusSubscriberFactory,
} from '../../src/forge/status/registry';
import {
  createStatusEventBus,
  resetDefaultStatusEventBus,
} from '../../src/forge/status/event-bus';
import {
  createStatusEventSink,
  persistStatusEvent,
} from '../../src/forge/status/status-event-handler';
import { emitConsumptionForCompletion } from '../../src/forge/status/consumption-emitter';
import { logger } from '../../src/logger';
// CF-5b T_b4 followup: real Moonraker subscriber + WS rig for test 1, so the
// `print_stats.filament_used` (mm) → grams conversion DB chain (printer_loadouts
// → materials → filament_products) is exercised end-to-end.
import { createMoonrakerSubscriber } from '../../src/forge/status/subscribers/moonraker';
import type {
  WsClientLike,
  WsFactory,
} from '../../src/forge/status/subscribers/_ws-client';
import {
  createForgeStatusWorker,
  type ForgeStatusWorker,
} from '../../src/workers/forge-status-worker';
import { markDispatched } from '../../src/forge/dispatch-state';
import { getDefaultRegistry as getDefaultDispatchRegistry } from '../../src/forge/dispatch/registry';
import type {
  DispatchHandler,
  DispatchContext,
  DispatchOutcome,
} from '../../src/forge/dispatch/handler';
import type {
  StatusEvent,
  StatusSubscriber,
  PrinterRecord,
  DecryptedCredential,
} from '../../src/forge/status/types';
import type { MaterialsUsed } from '../../src/db/schema.forge';

// ---------------------------------------------------------------------------
// Auth + next/server mocks (so the route handler can be invoked directly)
// ---------------------------------------------------------------------------

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

const mockAuthenticate = vi.fn();
vi.mock('../../src/auth/request-auth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-e2e-v2-005f-cross-pillar.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'a'.repeat(32);

// PrusaSlicer-style gcode with embedded slicer-estimate comments. This is
// the realistic artifact a real V2-005c slicer would produce. The estimate
// of 38.42g is what the operator-configured loadout records as
// `estimated_grams` for slot 0.
const SLICER_GCODE = [
  'G1 X0 Y0',
  'G1 X10 Y10',
  'G1 X20 Y20',
  'G1 X30 Y30',
  'M104 S0',
  '',
  '; filament used [g] = 38.42',
  '; filament used [cm3] = 31.97',
  '; filament_type = PLA',
  '; estimated printing time (normal mode) = 1h 23m 45s',
  '',
].join('\n');

// Mocked printer event lifecycle. The completion event reports
// `remain_percent = 20`, which the consumption emitter turns into a
// measured weight via the V2-005f-CF-1 fallback formula:
//
//     measured = estimated * (100 - remain_percent) / 100
//             = 38.42 * 0.80
//             = 30.736 grams
const ESTIMATED_GRAMS = 38.42;
const REMAIN_PERCENT_AT_END = 20;
const EXPECTED_MEASURED_GRAMS = ESTIMATED_GRAMS * (1 - REMAIN_PERCENT_AT_END / 100);
const INITIAL_MATERIAL_GRAMS = 1000;

function uid(): string {
  return crypto.randomUUID();
}

function actor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

async function flushAsyncQueue(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Stub StatusSubscriber — captures onEvent for direct driving
// ---------------------------------------------------------------------------

interface StubSubscriberRig {
  factory: StatusSubscriberFactory;
  /** The captured onEvent — set by start(). Tests fire events through this. */
  emit: (event: StatusEvent) => void;
  startedFor: PrinterRecord[];
}

function makeStubSubscriberRig(printerKind: string): StubSubscriberRig {
  const startedFor: PrinterRecord[] = [];
  let captured: ((event: StatusEvent) => void) | null = null;

  const factory: StatusSubscriberFactory = {
    create(): StatusSubscriber {
      let connected = false;
      return {
        protocol: 'moonraker',
        printerKind,
        async start(
          printer: PrinterRecord,
          _credential: DecryptedCredential | null,
          onEvent: (event: StatusEvent) => void,
        ): Promise<void> {
          startedFor.push(printer);
          captured = onEvent;
          connected = true;
        },
        async stop(): Promise<void> {
          connected = false;
          captured = null;
        },
        isConnected(): boolean {
          return connected;
        },
      };
    },
  };

  return {
    factory,
    startedFor,
    emit(event: StatusEvent): void {
      if (!captured) {
        throw new Error(
          'StubSubscriber: emit() called before start() — onEvent not captured yet',
        );
      }
      captured(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Stub DispatchHandler — proves V2-005d-a wiring without real Moonraker HTTP
// ---------------------------------------------------------------------------

let stubDispatchCalls: Array<{ printerId: string; jobId: string }> = [];

function makeStubMoonrakerHandler(): DispatchHandler {
  return {
    kind: 'fdm_klipper',
    async dispatch(ctx: DispatchContext): Promise<DispatchOutcome> {
      stubDispatchCalls.push({
        printerId: ctx.printer.id,
        jobId: ctx.job.id,
      });
      return { kind: 'success', remoteFilename: 'cube.gcode' };
    },
  };
}

// ---------------------------------------------------------------------------
// CF-5b T_b4 followup: Fake WebSocket rig for the real Moonraker subscriber.
// Mirrors the pattern in tests/integration/status-moonraker-integration.test.ts
// so test 1 can drive `notify_status_update` (filament_used: 6700 mm) +
// `notify_history_changed` (action=finished, status=completed) through the
// REAL subscriber. The subscriber's terminal-event handler then runs
// `convertFilamentMmToGrams` against the seeded printer_loadouts → materials
// → filament_products chain — exercising the full T_b1 conversion path.
// ---------------------------------------------------------------------------

type WsListener = (...args: unknown[]) => void;

interface FakeWs extends WsClientLike {
  __listeners: Record<string, WsListener[]>;
  __sent: string[];
  __closed: boolean;
  fireOpen(): void;
  fireMessage(json: unknown): void;
  fireClose(): void;
}

function makeFakeWs(): FakeWs {
  const listeners: Record<string, WsListener[]> = {};
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

interface WsFactoryRig {
  factory: WsFactory;
  sockets: FakeWs[];
}

function makeWsFactoryRig(): WsFactoryRig {
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

let cleanupFns: Array<() => Promise<void>> = [];
let workerRef: ForgeStatusWorker | null = null;
let tempDir: string | null = null;

beforeEach(async () => {
  stubDispatchCalls = [];
  cleanupFns = [];
  workerRef = null;
  resetDefaultSubscriberRegistry();
  resetDefaultStatusEventBus();
  getDefaultDispatchRegistry().clear();
});

afterEach(async () => {
  for (const fn of cleanupFns.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      /* swallow — best-effort cleanup */
    }
  }
  if (workerRef) {
    try {
      await workerRef.stop();
    } catch {
      /* ignore */
    }
    workerRef = null;
  }
  if (tempDir) {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tempDir = null;
  }
  vi.restoreAllMocks();
  resetDefaultSubscriberRegistry();
  resetDefaultStatusEventBus();
  try {
    getDefaultDispatchRegistry().clear();
  } catch {
    /* ignore */
  }
  resetDbCache();
});

describe('V2-005f-T_dcf14 cross-pillar e2e', () => {
  it('drives Loot → Stash → slicer artifact → dispatch → status events → consumption → ledger end-to-end', async () => {
    // -------------------------------------------------------------------
    // Setup phase — DB + migrations + clean singletons
    // -------------------------------------------------------------------

    // Wipe stale SQLite files so we start from migrations.
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${DB_PATH}${suffix}`);
      } catch {
        /* ignore */
      }
    }
    process.env.DATABASE_URL = DB_URL;
    process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
    resetDbCache();
    await runMigrations(DB_URL);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;

    // -------------------------------------------------------------------
    // Step 1: Scavenger ingest (simulated — direct Loot + LootFile seed).
    // V2-003 e2e tests cover the URL → adapter → pipeline arc; here we
    // skip ahead to the post-ingest state with a real on-disk gcode file
    // so the artifact looks like what V2-005c would have produced.
    // -------------------------------------------------------------------

    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-cross-pillar-'));
    const gcodePath = path.join(tempDir, 'cube.gcode');
    await fsp.writeFile(gcodePath, SLICER_GCODE, 'utf8');

    const ownerId = uid();
    await db.insert(schema.user).values({
      id: ownerId,
      name: 'Cross-pillar test user',
      email: `${ownerId}@cross-pillar.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const stashRootId = uid();
    await db.insert(schema.stashRoots).values({
      id: stashRootId,
      ownerId,
      name: 'root',
      path: tempDir,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const collectionId = uid();
    await db.insert(schema.collections).values({
      id: collectionId,
      ownerId,
      name: 'cross-pillar-c',
      pathTemplate: '{title|slug}',
      stashRootId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Step 2: Stash placement — Loot row + LootFile pointing at the real file.
    const lootId = uid();
    await db.insert(schema.loot).values({
      id: lootId,
      collectionId,
      title: 'Test Cube',
      tags: [],
      fileMissing: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const slicedFileId = uid();
    const fileBuf = await fsp.readFile(gcodePath);
    const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
    await db.insert(schema.lootFiles).values({
      id: slicedFileId,
      lootId,
      path: 'cube.gcode',
      format: 'gcode',
      size: fileBuf.length,
      hash: fileHash,
      origin: 'manual',
      createdAt: new Date(),
    });

    // -------------------------------------------------------------------
    // Step 3: Forge dispatch — seed printer + Material + dispatch_job.
    // -------------------------------------------------------------------

    const printerId = uid();
    await db.insert(schema.printers).values({
      id: printerId,
      ownerId,
      kind: 'fdm_klipper',
      name: 'Test Klipper',
      connectionConfig: {
        host: '192.168.1.50',
        port: 7125,
        scheme: 'http',
        requiresAuth: false,
        startPrint: true,
      },
      active: true,
      createdAt: new Date(),
    });

    // Materials seeding — a real Material so the consumption emission has
    // something to decrement.
    const matResult = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        brand: 'TestBrand',
        subtype: 'PLA',
        colors: ['#112233'],
        colorPattern: 'solid',
        initialAmount: INITIAL_MATERIAL_GRAMS,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    if (!matResult.ok) {
      throw new Error(`createMaterial failed: ${matResult.reason}`);
    }
    const materialId = matResult.material.id;

    // Pre-populate materials_used with a real material_id (V2-005f-CF-1
    // simulation: operator has manually configured the slot loadout).
    const seededMaterialsUsed: MaterialsUsed = [
      {
        slot_index: 0,
        material_id: materialId,
        estimated_grams: ESTIMATED_GRAMS,
        measured_grams: null,
      },
    ];

    const dispatchJobId = uid();
    await db.insert(schema.dispatchJobs).values({
      id: dispatchJobId,
      ownerId,
      lootId,
      targetKind: 'printer',
      targetId: printerId,
      slicedFileId,
      status: 'claimed',
      materialsUsed: seededMaterialsUsed,
      createdAt: new Date(),
    });

    // -------------------------------------------------------------------
    // Step 4: Mocked Moonraker dispatcher.
    // Register a stub DispatchHandler in the registry, and verify the
    // dispatcher wiring by invoking it directly + then transitioning the
    // job to 'dispatched' (the claim worker would do this in production;
    // doing it directly is a documented plan-allowed simplification).
    // -------------------------------------------------------------------

    const stubHandler = makeStubMoonrakerHandler();
    const dispatchRegistry = getDefaultDispatchRegistry();
    dispatchRegistry.register(stubHandler);

    // Verify the stub handler is reachable via the V2-005d-a registry. The
    // claim worker would resolve this and pass a real DispatchContext; for
    // T_dcf14 we verify the registry wiring then drive the state-machine
    // directly to 'dispatched' (a documented plan-allowed simplification).
    const resolved = dispatchRegistry.get('fdm_klipper');
    expect(resolved).toBe(stubHandler);
    expect(resolved!.kind).toBe('fdm_klipper');

    // Drive the dispatch lifecycle via the real V2-005a-T3 state machine.
    // The claim worker does this in production after the handler succeeds.
    const transitionResult = await markDispatched(
      { jobId: dispatchJobId },
      { dbUrl: DB_URL },
    );
    expect(transitionResult.ok).toBe(true);

    // -------------------------------------------------------------------
    // Step 5: Status worker + stub subscriber wired with REAL sink +
    // REAL consumption emitter. This is the heart of V2-005f wiring.
    // -------------------------------------------------------------------

    const stubRig = makeStubSubscriberRig('fdm_klipper');
    const subscriberRegistry = createSubscriberRegistry();
    subscriberRegistry.register('fdm_klipper', stubRig.factory);

    const bus = createStatusEventBus();
    const busEventCounts = new Map<string, number>();

    let workerNotifyTerminalCalls = 0;
    // eslint-disable-next-line prefer-const
    let workerForCircular: ForgeStatusWorker;
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        notifyTerminal: async (a) => {
          workerNotifyTerminalCalls += 1;
          await workerForCircular.notifyTerminal(a);
        },
        emitConsumption: async ({ dispatchJobId: jid, event }) => {
          await emitConsumptionForCompletion(
            { dispatchJobId: jid, event },
            { dbUrl: DB_URL },
          );
        },
        emitToBus: (id, event) => {
          busEventCounts.set(id, (busEventCounts.get(id) ?? 0) + 1);
          bus.emit(id, event);
        },
      },
    });

    workerForCircular = createForgeStatusWorker({
      registry: subscriberRegistry,
      dbUrl: DB_URL,
      onEvent: (printerIdArg, event) => {
        void sink(printerIdArg, event);
      },
    });
    workerRef = workerForCircular;

    // Trigger subscriber start.
    await workerForCircular.notifyDispatched({ dispatchJobId, printerId });
    await flushAsyncQueue();

    expect(workerForCircular.isWatching(printerId)).toBe(true);
    expect(stubRig.startedFor).toHaveLength(1);
    expect(stubRig.startedFor[0]!.id).toBe(printerId);

    // Drive a realistic event lifecycle: progress 25/50/75 → completed
    // with measured consumption. This is what a real Moonraker subscriber
    // would emit on a happy-path 1-spool print.
    const baseTime = Date.now();
    const remoteJobRef = 'cube.gcode';

    stubRig.emit({
      kind: 'progress',
      remoteJobRef,
      progressPct: 25,
      rawPayload: { phase: 'p25' },
      occurredAt: new Date(baseTime + 1000),
    });
    await flushAsyncQueue();

    stubRig.emit({
      kind: 'progress',
      remoteJobRef,
      progressPct: 50,
      rawPayload: { phase: 'p50' },
      occurredAt: new Date(baseTime + 2000),
    });
    await flushAsyncQueue();

    stubRig.emit({
      kind: 'progress',
      remoteJobRef,
      progressPct: 75,
      rawPayload: { phase: 'p75' },
      occurredAt: new Date(baseTime + 3000),
    });
    await flushAsyncQueue();

    stubRig.emit({
      kind: 'completed',
      remoteJobRef,
      progressPct: 100,
      // remain_percent=20 → measured = 38.42 * 0.80 = 30.736g
      measuredConsumption: [
        { slot_index: 0, grams: 0, remain_percent: REMAIN_PERCENT_AT_END },
      ],
      rawPayload: { phase: 'completed' },
      occurredAt: new Date(baseTime + 4000),
    });
    await flushAsyncQueue();
    // Extra settle — consumption emission chains through ledger persist.
    await flushAsyncQueue();

    // -------------------------------------------------------------------
    // Step 6+7+8: Final assertions
    // -------------------------------------------------------------------

    // (a) dispatch_job is completed with progress_pct=100 + completed_at set.
    const jobRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, dispatchJobId));
    expect(jobRows).toHaveLength(1);
    const jobRow = jobRows[0]!;
    expect(jobRow.status).toBe('completed');
    expect(jobRow.progressPct).toBe(100);
    expect(jobRow.lastStatusAt).not.toBeNull();
    expect(jobRow.completedAt).not.toBeNull();

    // materialsUsed remains as pre-populated (Phase B writes ledger, not
    // back into materials_used).
    const persistedMaterials = jobRow.materialsUsed as MaterialsUsed | null;
    expect(persistedMaterials).not.toBeNull();
    expect(persistedMaterials!).toHaveLength(1);
    expect(persistedMaterials![0]!.material_id).toBe(materialId);

    // (b) dispatch_status_events has at least 4 rows (3 progress + 1 completed).
    const statusEvents = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, dispatchJobId));
    expect(statusEvents.length).toBeGreaterThanOrEqual(4);
    const statusKinds = statusEvents.map((e: { eventKind: string }) => e.eventKind);
    expect(statusKinds.filter((k: string) => k === 'progress').length).toBeGreaterThanOrEqual(3);
    expect(statusKinds).toContain('completed');

    // (c) Ledger has a `material.consumed` row with provenance='measured'
    // attributed to this dispatch_job + slot 0, with the expected weight.
    const ledgerRows = await db
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.consumed'),
          eq(schema.ledgerEvents.provenanceClass, 'measured'),
        ),
      );
    expect(ledgerRows.length).toBeGreaterThanOrEqual(1);
    const measuredRow = ledgerRows.find((r: { payload: unknown }) => {
      const p = (typeof r.payload === 'string'
        ? JSON.parse(r.payload as string)
        : r.payload) as {
        attributedTo?: { jobId?: string; note?: string };
      };
      return (
        p.attributedTo?.jobId === dispatchJobId &&
        p.attributedTo?.note === 'slot:0'
      );
    });
    expect(measuredRow).toBeDefined();
    const measuredPayload = (typeof measuredRow!.payload === 'string'
      ? JSON.parse(measuredRow!.payload as string)
      : measuredRow!.payload) as {
      weightConsumed: number;
      attributedTo: { kind: string; jobId: string; lootId: string; note: string };
    };
    // The ledger row's `subjectId` carries the materialId (V2-007a-T8 schema).
    expect(measuredRow!.subjectId).toBe(materialId);
    // The ledger row's `provenanceClass` column carries the provenance — not
    // the JSON payload (per V2-007a-T3 ledger schema).
    expect(measuredRow!.provenanceClass).toBe('measured');
    // ~30.736 grams — allow tiny floating-point slack.
    expect(measuredPayload.weightConsumed).toBeCloseTo(EXPECTED_MEASURED_GRAMS, 2);
    expect(measuredPayload.attributedTo.kind).toBe('print');
    expect(measuredPayload.attributedTo.lootId).toBe(lootId);

    // (d) Material remaining_amount decremented by the measured consumption.
    const materialRows = await db
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, materialId));
    expect(materialRows).toHaveLength(1);
    expect(materialRows[0]!.remainingAmount).toBeCloseTo(
      INITIAL_MATERIAL_GRAMS - EXPECTED_MEASURED_GRAMS,
      2,
    );

    // (e) Worker received the terminal notification.
    expect(workerNotifyTerminalCalls).toBeGreaterThanOrEqual(1);

    // (f) SSE bus received every event for this dispatch job (4+).
    expect(busEventCounts.get(dispatchJobId) ?? 0).toBeGreaterThanOrEqual(4);

    // -------------------------------------------------------------------
    // Step 8 (optional): GET /api/v1/forge/dispatch/:id/status — proves
    // the HTTP surface returns the right shape after the cross-pillar
    // chain has settled.
    // -------------------------------------------------------------------

    mockAuthenticate.mockResolvedValue(actor(ownerId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/route'
    );
    const req = new Request(
      `http://localhost/api/v1/forge/dispatch/${dispatchJobId}/status`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any, {
      params: Promise.resolve({ id: dispatchJobId }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      dispatch_job_id: string;
      status: string;
      progress_pct: number | null;
      last_status_at: number | null;
      events: Array<{ event_kind: string }>;
    };
    expect(json.dispatch_job_id).toBe(dispatchJobId);
    expect(json.status).toBe('completed');
    expect(json.progress_pct).toBe(100);
    expect(json.last_status_at).not.toBeNull();
    expect(json.events.length).toBeGreaterThanOrEqual(4);
    expect(json.events.map((e) => e.event_kind)).toContain('completed');
  });

  // ---------------------------------------------------------------------------
  // V2-005f-CF-1 T_g5 — real loadout path
  //
  // The original cross-pillar test (above) pre-populates
  // `dispatch_jobs.materials_used` with a real material_id, simulating the
  // V2-005f-CF-1 endpoint. T_g5 replaces that shortcut with the real chain:
  //
  //   loadInPrinter(materialId, printerId, slot 0)         (T_g2)
  //          ↓                                              writes printer_loadouts row
  //          ↓                                              emits material.loaded ledger event
  //   runOneClaimTick()                                    (T_g4)
  //          ↓                                              extractAndPersistSlicerEstimate
  //          ↓                                              queries getCurrentLoadout(printerId)
  //          ↓                                              fills materials_used[].material_id
  //          ↓                                              markDispatched
  //   stub subscriber emits progress + completed events
  //          ↓
  //   consumption emitter Phase B fires material.consumed (provenance='measured')
  //
  // This test is the proof that V2-005f-CF-1 closed the loadout-tracking
  // gap end-to-end: Phase B emission now happens because material_id is
  // non-empty, sourced from the printer_loadouts table.
  // ---------------------------------------------------------------------------
  it('cross-pillar with real loadout (T_g5) — materialLoad → dispatch → status → consumption', async () => {
    // Wipe stale SQLite files so we start from migrations.
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${DB_PATH}${suffix}`);
      } catch {
        /* ignore */
      }
    }
    process.env.DATABASE_URL = DB_URL;
    process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
    resetDbCache();
    await runMigrations(DB_URL);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;

    tempDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'lootgoblin-cross-pillar-tg5-'),
    );
    const gcodePath = path.join(tempDir, 'cube.gcode');
    await fsp.writeFile(gcodePath, SLICER_GCODE, 'utf8');

    const ownerId = uid();
    await db.insert(schema.user).values({
      id: ownerId,
      name: 'T_g5 cross-pillar test user',
      email: `${ownerId}@cross-pillar-tg5.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const stashRootId = uid();
    await db.insert(schema.stashRoots).values({
      id: stashRootId,
      ownerId,
      name: 'root',
      path: tempDir,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const collectionId = uid();
    await db.insert(schema.collections).values({
      id: collectionId,
      ownerId,
      name: 'cross-pillar-tg5',
      pathTemplate: '{title|slug}',
      stashRootId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lootId = uid();
    await db.insert(schema.loot).values({
      id: lootId,
      collectionId,
      title: 'T_g5 Cube',
      tags: [],
      fileMissing: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const slicedFileId = uid();
    const fileBuf = await fsp.readFile(gcodePath);
    const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
    await db.insert(schema.lootFiles).values({
      id: slicedFileId,
      lootId,
      path: 'cube.gcode',
      format: 'gcode',
      size: fileBuf.length,
      hash: fileHash,
      origin: 'manual',
      createdAt: new Date(),
    });

    // Bootstrap the central agent so runOneClaimTick has an agent_id.
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const agentId = bootstrap.agentId;

    // Printer + reachable_via wiring so findClaimableCandidate sees this
    // job as reachable by the central agent.
    const printerId = uid();
    await db.insert(schema.printers).values({
      id: printerId,
      ownerId,
      kind: 'fdm_klipper',
      name: 'T_g5 Test Klipper',
      connectionConfig: {
        host: '192.168.1.50',
        port: 7125,
        scheme: 'http',
        requiresAuth: false,
        startPrint: true,
      },
      active: true,
      createdAt: new Date(),
    });
    await db.insert(schema.printerReachableVia).values({
      printerId,
      agentId,
    });

    // Material + LOAD into printer slot 0 — this is the T_g2 entry point
    // that replaces the T_dcf14 pre-population shortcut. Emits
    // `material.loaded` ledger event as a side effect.
    const matResult = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        brand: 'TestBrand',
        subtype: 'PLA',
        colors: ['#112233'],
        colorPattern: 'solid',
        initialAmount: INITIAL_MATERIAL_GRAMS,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    if (!matResult.ok) {
      throw new Error(`createMaterial failed: ${matResult.reason}`);
    }
    const materialId = matResult.material.id;

    const loadResult = await loadInPrinter(
      {
        materialId,
        printerId,
        slotIndex: 0,
        userId: ownerId,
      },
      { dbUrl: DB_URL },
    );
    expect(loadResult.ok).toBe(true);

    // Create the dispatch job in 'claimable' status so runOneClaimTick will
    // pick it up immediately. Note: we do NOT pre-populate materials_used —
    // that's the whole point of this test; T_g4's claim worker fills it
    // from the loadout we just created.
    const createJobResult = await createDispatchJob(
      {
        ownerId,
        lootId,
        targetKind: 'printer',
        targetId: printerId,
        initialStatus: 'claimable',
      },
      { dbUrl: DB_URL },
    );
    if (!createJobResult.ok) {
      throw new Error(
        `createDispatchJob failed: ${createJobResult.reason}: ${createJobResult.details ?? ''}`,
      );
    }
    const dispatchJobId = createJobResult.jobId;

    // Forge artifact pointing at the on-disk gcode — required for
    // extractAndPersistSlicerEstimate (which is the gateway to
    // getCurrentLoadout()).
    await db.insert(schema.forgeArtifacts).values({
      id: uid(),
      dispatchJobId,
      kind: 'gcode',
      storagePath: gcodePath,
      sizeBytes: fileBuf.length,
      sha256: fileHash,
      mimeType: 'text/x.gcode',
      metadataJson: null,
      createdAt: new Date(),
    });

    // Stub DispatchHandler — real registry call returning success.
    const stubHandler = makeStubMoonrakerHandler();
    const dispatchRegistry = getDefaultDispatchRegistry();
    dispatchRegistry.register(stubHandler);

    // Status worker + sink + bus + stub subscriber, identical to T_dcf14.
    const stubRig = makeStubSubscriberRig('fdm_klipper');
    const subscriberRegistry = createSubscriberRegistry();
    subscriberRegistry.register('fdm_klipper', stubRig.factory);

    const bus = createStatusEventBus();
    const busEventCounts = new Map<string, number>();

    let workerNotifyTerminalCalls = 0;
    // eslint-disable-next-line prefer-const
    let workerForCircular: ForgeStatusWorker;
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        notifyTerminal: async (a) => {
          workerNotifyTerminalCalls += 1;
          await workerForCircular.notifyTerminal(a);
        },
        emitConsumption: async ({ dispatchJobId: jid, event }) => {
          await emitConsumptionForCompletion(
            { dispatchJobId: jid, event },
            { dbUrl: DB_URL },
          );
        },
        emitToBus: (id, event) => {
          busEventCounts.set(id, (busEventCounts.get(id) ?? 0) + 1);
          bus.emit(id, event);
        },
      },
    });

    workerForCircular = createForgeStatusWorker({
      registry: subscriberRegistry,
      dbUrl: DB_URL,
      onEvent: (printerIdArg, event) => {
        void sink(printerIdArg, event);
      },
    });
    workerRef = workerForCircular;

    // Drive the claim tick — this is where T_g4 fires:
    // extractAndPersistSlicerEstimate → getCurrentLoadout → fills
    // materials_used[0].material_id from the loadout, then markDispatched
    // and the onJobDispatched hook spins up the status subscriber.
    const tickResult = await runOneClaimTick({
      agentId,
      dbUrl: DB_URL,
      onJobDispatched: async (a) => workerForCircular.notifyDispatched(a),
    });
    expect(tickResult).toBe('ran');
    await flushAsyncQueue();

    // Sanity: materials_used was populated by the worker, NOT by us.
    const claimedRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, dispatchJobId));
    expect(claimedRows).toHaveLength(1);
    const claimedMaterials = claimedRows[0]!
      .materialsUsed as MaterialsUsed | null;
    expect(claimedMaterials).not.toBeNull();
    expect(claimedMaterials!).toHaveLength(1);
    expect(claimedMaterials![0]!.slot_index).toBe(0);
    // KEY: this is the T_g4 fill — no pre-population.
    expect(claimedMaterials![0]!.material_id).toBe(materialId);
    expect(claimedMaterials![0]!.estimated_grams).toBeCloseTo(
      ESTIMATED_GRAMS,
      2,
    );

    // Subscriber should have started.
    expect(workerForCircular.isWatching(printerId)).toBe(true);
    expect(stubRig.startedFor.length).toBeGreaterThanOrEqual(1);
    expect(stubRig.startedFor[0]!.id).toBe(printerId);

    // Drive the status events.
    const baseTime = Date.now();
    const remoteJobRef = 'cube.gcode';

    stubRig.emit({
      kind: 'progress',
      remoteJobRef,
      progressPct: 50,
      rawPayload: { phase: 'p50' },
      occurredAt: new Date(baseTime + 1000),
    });
    await flushAsyncQueue();

    stubRig.emit({
      kind: 'completed',
      remoteJobRef,
      progressPct: 100,
      // remain_percent=20 → measured = 38.42 * 0.80 = 30.736g
      measuredConsumption: [
        { slot_index: 0, grams: 0, remain_percent: REMAIN_PERCENT_AT_END },
      ],
      rawPayload: { phase: 'completed' },
      occurredAt: new Date(baseTime + 2000),
    });
    await flushAsyncQueue();
    await flushAsyncQueue();

    // ----- Assertions -----

    // (a) dispatch_job is completed.
    const finalRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, dispatchJobId));
    const finalRow = finalRows[0]!;
    expect(finalRow.status).toBe('completed');
    expect(finalRow.progressPct).toBe(100);
    expect(finalRow.completedAt).not.toBeNull();

    // (b) materials_used.material_id is the loaded material.
    const finalMaterials = finalRow.materialsUsed as MaterialsUsed | null;
    expect(finalMaterials).not.toBeNull();
    expect(finalMaterials!).toHaveLength(1);
    expect(finalMaterials![0]!.material_id).toBe(materialId);
    expect(finalMaterials![0]!.estimated_grams).toBeCloseTo(
      ESTIMATED_GRAMS,
      2,
    );

    // (c) Ledger contains BOTH a 'material.loaded' event (from T_g2's
    // loadInPrinter) AND a 'material.consumed' event with
    // provenance='measured' (from Phase B emission). This is the proof
    // point: real-loadout path produces real consumption events.
    const loadedRows = await db
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.loaded'),
          eq(schema.ledgerEvents.subjectId, materialId),
        ),
      );
    expect(loadedRows.length).toBeGreaterThanOrEqual(1);
    const loadedRow = loadedRows[0]!;
    const loadedPayload = (typeof loadedRow.payload === 'string'
      ? JSON.parse(loadedRow.payload as string)
      : loadedRow.payload) as { printerId: string; slotIndex: number };
    expect(loadedPayload.printerId).toBe(printerId);
    expect(loadedPayload.slotIndex).toBe(0);

    const measuredRows = await db
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.consumed'),
          eq(schema.ledgerEvents.provenanceClass, 'measured'),
        ),
      );
    expect(measuredRows.length).toBeGreaterThanOrEqual(1);
    const measuredRow = measuredRows.find((r: { payload: unknown }) => {
      const p = (typeof r.payload === 'string'
        ? JSON.parse(r.payload as string)
        : r.payload) as {
        attributedTo?: { jobId?: string; note?: string };
      };
      return (
        p.attributedTo?.jobId === dispatchJobId &&
        p.attributedTo?.note === 'slot:0'
      );
    });
    expect(measuredRow).toBeDefined();
    expect(measuredRow!.subjectId).toBe(materialId);
    expect(measuredRow!.provenanceClass).toBe('measured');
    const measuredPayload = (typeof measuredRow!.payload === 'string'
      ? JSON.parse(measuredRow!.payload as string)
      : measuredRow!.payload) as {
      weightConsumed: number;
      attributedTo: { kind: string; jobId: string; lootId: string; note: string };
    };
    expect(measuredPayload.attributedTo.kind).toBe('print');
    expect(measuredPayload.attributedTo.jobId).toBe(dispatchJobId);
    expect(measuredPayload.attributedTo.lootId).toBe(lootId);
    expect(measuredPayload.weightConsumed).toBeCloseTo(
      EXPECTED_MEASURED_GRAMS,
      2,
    );

    // (d) Material remaining_amount decremented by BOTH Phase A (estimated)
    // and Phase B (measured) emissions. With the loadout filled before
    // claim, Phase A now fires for slot 0 (decrements ESTIMATED_GRAMS),
    // and Phase B's terminal emission decrements EXPECTED_MEASURED_GRAMS.
    // V2-007a-T13 reports query by provenance — both decrements are
    // intentional, recording the slicer estimate AND the printer-reported
    // actual.
    const matRows = await db
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, materialId));
    expect(matRows[0]!.remainingAmount).toBeCloseTo(
      INITIAL_MATERIAL_GRAMS - ESTIMATED_GRAMS - EXPECTED_MEASURED_GRAMS,
      2,
    );

    // (d.1) The Phase A 'material.consumed' (provenance='estimated') row
    // exists alongside the Phase B 'measured' row. This is the unique
    // T_g5 invariant: real-loadout path produces BOTH ledger rows.
    const estimatedRows = await db
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.consumed'),
          eq(schema.ledgerEvents.provenanceClass, 'estimated'),
          eq(schema.ledgerEvents.subjectId, materialId),
        ),
      );
    expect(estimatedRows.length).toBeGreaterThanOrEqual(1);

    // (e) Worker received the terminal notification + bus saw events.
    expect(workerNotifyTerminalCalls).toBeGreaterThanOrEqual(1);
    expect(busEventCounts.get(dispatchJobId) ?? 0).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // V2-005f-CF-5b T_b4 — divergence detection e2e tests
  //
  // Four scenarios proving the full CF-5b production path end-to-end:
  //   1. Klipper single-color: measured << estimated → warning written
  //   2. Klipper single-color: measured ≈ estimated → no warning, ratio logged
  //   3. Bambu multi-material: aggregate ratio < 0.40 → warning written
  //   4. SDCP resin: isFdmKind gate → no divergence check, no warning
  //
  // Production-path note (FG-L12):
  //   All four tests use the SAME sink wiring as instrumentation.ts —
  //   `createStatusEventSink` receives a real `persistWarningStatusEvent`
  //   closure that calls `persistStatusEvent` + bus emit. No test stubs for
  //   Phase C. The whole point is exercising the production path end-to-end.
  //
  // Test 1 conversion-DB-chain coverage:
  //   Test 1 drives `print_stats.filament_used: 6700` (mm) through the REAL
  //   Moonraker subscriber + WS rig (NOT a stub), so convertFilamentMmToGrams
  //   walks the real DB chain (printer_loadouts → materials → filament_products)
  //   to produce the measured grams. A regression in the conversion (wrong
  //   density lookup, formula error) would surface here. Tests 2/3/4 use the
  //   simpler stub rig — protocol-conversion regressions for those protocols
  //   live in the per-protocol integration tests.
  //
  // Logger spy teardown (FG-L11):
  //   Each test that spies on logger.info restores mocks in afterEach. The
  //   outer afterEach already calls vi.restoreAllMocks(), so we are covered.
  // ---------------------------------------------------------------------------

  it('CF-5b divergence detection — Klipper print with measured << estimated triggers warning', async () => {
    // -----------------------------------------------------------------------
    // DB + migrations
    // -----------------------------------------------------------------------
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    process.env.DATABASE_URL = DB_URL;
    process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
    resetDbCache();
    await runMigrations(DB_URL);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;

    // -----------------------------------------------------------------------
    // Spy on logger.info before any test code so we catch the ratio log
    // -----------------------------------------------------------------------
    const infoSpy: MockInstance = vi.spyOn(logger, 'info');

    // -----------------------------------------------------------------------
    // Seed: user, stash, collection, loot + gcode, printer, material, job
    // -----------------------------------------------------------------------
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-cf5b-klipper-warn-'));
    const gcodePath = path.join(tempDir, 'cube.gcode');
    await fsp.writeFile(gcodePath, SLICER_GCODE, 'utf8');

    const ownerId = uid();
    await db.insert(schema.user).values({
      id: ownerId,
      name: 'CF-5b Klipper warn user',
      email: `${ownerId}@cf5b-klipper-warn.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const stashRootId = uid();
    await db.insert(schema.stashRoots).values({
      id: stashRootId, ownerId, name: 'root', path: tempDir,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const collectionId = uid();
    await db.insert(schema.collections).values({
      id: collectionId, ownerId, name: 'cf5b-klipper-warn-c',
      pathTemplate: '{title|slug}', stashRootId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const lootId = uid();
    await db.insert(schema.loot).values({
      id: lootId, collectionId, title: 'CF-5b Klipper warn cube',
      tags: [], fileMissing: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const fileBuf = await fsp.readFile(gcodePath);
    const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
    const slicedFileId = uid();
    await db.insert(schema.lootFiles).values({
      id: slicedFileId, lootId, path: 'cube.gcode', format: 'gcode',
      size: fileBuf.length, hash: fileHash, origin: 'manual', createdAt: new Date(),
    });

    const printerId = uid();
    await db.insert(schema.printers).values({
      id: printerId, ownerId, kind: 'fdm_klipper', name: 'CF-5b Klipper',
      // requiresAuth=false so the real Moonraker subscriber connects without
      // needing a credential row (status-moonraker-real.test pattern).
      connectionConfig: { host: '192.168.1.50', port: 7125, scheme: 'http', requiresAuth: false, startPrint: true },
      active: true, createdAt: new Date(),
    });

    // -----------------------------------------------------------------------
    // CF-5b T_b4 followup — seed the conversion DB chain end-to-end:
    //   filament_products (PLA, density=1.24, diameterMm=1.75)
    //   → materials.product_id → printer_loadouts (slot 0, current)
    //
    // The real Moonraker subscriber's terminal-event handler calls
    // convertFilamentMmToGrams which walks this chain. With density=1.24 and
    // diameter=1.75 (PLA defaults), filament_used=6700mm yields
    //   grams = 6700 × π × (1.75/2)² / 1000 × 1.24 ≈ 19.98 g
    // ratio = 19.98 / 50 = 0.3996 < 0.50 single-color threshold → warning.
    // -----------------------------------------------------------------------
    const productId = uid();
    await db.insert(schema.filamentProducts).values({
      id: productId,
      brand: 'TestBrand',
      subtype: 'PLA',
      colors: ['#aabbcc'],
      colorPattern: 'solid',
      diameterMm: 1.75,
      density: 1.24,
      ownerId: null,
      source: 'system:spoolmandb',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Material linked to the catalog product so convertFilamentMmToGrams
    // resolves density+diameter via the catalog (densitySource='catalog').
    const matResult = await createMaterial(
      { ownerId, kind: 'filament_spool', brand: 'TestBrand', subtype: 'PLA',
        colors: ['#aabbcc'], colorPattern: 'solid', initialAmount: 1000, unit: 'g',
        productId },
      { dbUrl: DB_URL },
    );
    if (!matResult.ok) throw new Error(`createMaterial failed: ${matResult.reason}`);
    const materialId = matResult.material.id;

    // Load the material into the printer's slot 0 — populates printer_loadouts
    // so convertFilamentMmToGrams's first JOIN resolves.
    const loadResult = await loadInPrinter(
      { materialId, printerId, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    if (!loadResult.ok) throw new Error(`loadInPrinter failed: ${loadResult.reason}`);

    const CF5B_ESTIMATED_GRAMS = 50;
    // 6700mm × π × (1.75/2)² × 1.24 / 1000 ≈ 19.9831g — the value the real
    // T_b1 conversion will compute and surface via measured_grams.
    const EXPECTED_KLIPPER_MEASURED_GRAMS =
      6700 * Math.PI * (1.75 / 2) ** 2 * 1.24 / 1000;

    const dispatchJobId = uid();
    await db.insert(schema.dispatchJobs).values({
      id: dispatchJobId, ownerId, lootId, targetKind: 'printer', targetId: printerId,
      slicedFileId, status: 'dispatched',
      materialsUsed: [
        { slot_index: 0, material_id: materialId, estimated_grams: CF5B_ESTIMATED_GRAMS, measured_grams: null },
      ],
      createdAt: new Date(),
    });

    // -----------------------------------------------------------------------
    // Wire the REAL Moonraker subscriber + WS rig.
    // The stub rig is bypassed for this test — we want filament_used to flow
    // through the actual subscriber so convertFilamentMmToGrams runs.
    // -----------------------------------------------------------------------
    const wsFactoryRig = makeWsFactoryRig();
    const subscriberRegistry = createSubscriberRegistry();
    subscriberRegistry.register('fdm_klipper', {
      create: () =>
        createMoonrakerSubscriber({
          wsFactory: wsFactoryRig.factory,
          reconnectBackoffMs: [10],
        }),
    });

    const bus = createStatusEventBus();
    const busEventKinds: string[] = [];
    // Subscribe to bus events for this dispatch job to capture warning emits from
    // persistWarningStatusEvent (which calls bus.emit directly, not via emitToBus).
    // All bus emits (including emitToBus) are captured via this single subscription;
    // no need to also push from emitToBus.
    let busUnsub: (() => void) | null = null;

    let workerNotifyTerminalCalls = 0;
    // eslint-disable-next-line prefer-const
    let workerForCircular: ForgeStatusWorker;

    // Production-wired persistWarningStatusEvent closure — mirrors instrumentation.ts.
    const persistWarningStatusEvent = async (args: {
      dispatchJobId: string;
      printerKind: string;
      printerId?: string;
      errorCode: string;
      protocol: string;
      severity: 'info' | 'warning' | 'error';
      message?: string;
      occurredAt: Date;
    }): Promise<void> => {
      const syntheticEvent = {
        kind: 'warning' as const,
        remoteJobRef: '',
        errorCode: args.errorCode,
        errorMessage: args.message,
        severity: args.severity,
        rawPayload: { source: 'cf-5b-divergence', protocol: args.protocol },
        occurredAt: args.occurredAt,
      };
      if (args.printerId) {
        await persistStatusEvent({
          printerId: args.printerId,
          dispatchJobId: args.dispatchJobId,
          printerKind: args.printerKind,
          event: syntheticEvent,
          dbUrl: DB_URL,
        });
      }
      bus.emit(args.dispatchJobId, syntheticEvent);
    };

    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        notifyTerminal: async (a) => {
          workerNotifyTerminalCalls += 1;
          await workerForCircular.notifyTerminal(a);
        },
        emitConsumption: async ({ dispatchJobId: jid, event, printerKind, printerId: pid }) => {
          await emitConsumptionForCompletion(
            { dispatchJobId: jid, event, printerKind, printerId: pid },
            { dbUrl: DB_URL, persistWarningStatusEvent },
          );
        },
        // All bus emits (including emitToBus) are captured via the single
        // bus.subscribe below; don't push here too (would double-count).
        emitToBus: (jid, event) => {
          bus.emit(jid, event);
        },
      },
    });

    // Subscribe after sink is built (dispatchJobId is known) to capture ALL
    // bus events for this job — including the warning emit from persistWarningStatusEvent.
    busUnsub = bus.subscribe(dispatchJobId, (event) => {
      busEventKinds.push(event.kind);
    });
    cleanupFns.push(async () => { busUnsub?.(); });

    workerForCircular = createForgeStatusWorker({
      registry: subscriberRegistry,
      dbUrl: DB_URL,
      onEvent: (printerIdArg, event) => { void sink(printerIdArg, event); },
    });
    workerRef = workerForCircular;

    await workerForCircular.notifyDispatched({ dispatchJobId, printerId });
    await flushAsyncQueue();

    // The subscriber's start() awaits the WS factory; settle then grab the socket.
    expect(wsFactoryRig.sockets).toHaveLength(1);
    const ws = wsFactoryRig.sockets[0]!;

    // -----------------------------------------------------------------------
    // Drive Moonraker JSON-RPC frames through the real subscriber:
    //   1) open + initial subscribe-reply (id=1) → marks subscriber connected
    //   2) notify_status_update with print_stats.filament_used: 6700  (mm)
    //      — subscriber stashes latestFilamentUsedMm=6700 (T_b1 capture)
    //   3) notify_history_changed action=finished, status=completed
    //      — subscriber's terminal handler runs convertFilamentMmToGrams
    //        which walks printer_loadouts → materials → filament_products,
    //        gets density=1.24 + diameter=1.75 from the catalog row, and
    //        emits the completed event with measuredConsumption populated.
    // -----------------------------------------------------------------------
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

    // Drive a status update with the filament_used value so the subscriber's
    // notify_status_update handler captures it into latestFilamentUsedMm.
    ws.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [
        {
          print_stats: {
            state: 'printing',
            filename: 'cube.gcode',
            filament_used: 6700, // mm — converted to ~19.98g via DB chain
          },
          display_status: { progress: 0.99 },
        },
        100,
      ],
    });
    await flushAsyncQueue();

    // Finalize via notify_history_changed — terminal handler reads the stashed
    // latestFilamentUsedMm and runs the conversion before emitting completed.
    ws.fireMessage({
      jsonrpc: '2.0',
      method: 'notify_history_changed',
      params: [
        {
          action: 'finished',
          job: {
            filename: 'cube.gcode',
            status: 'completed',
            total_duration: 3600,
            print_duration: 3550,
          },
        },
      ],
    });
    // Settle: convertFilamentMmToGrams is async (T_b1 void promise pattern),
    // sink correlate is async, persist+emitConsumption chain awaits DB writes,
    // and divergence Phase C runs after Phase B. Drain generously.
    await flushAsyncQueue();
    await flushAsyncQueue();
    await flushAsyncQueue();
    await flushAsyncQueue();

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    // (a) dispatch_job completed
    const jobRows = await db.select().from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, dispatchJobId));
    expect(jobRows[0]!.status).toBe('completed');

    // (b) The back-calculated measured grams (~19.98g for 6700mm PLA 1.75mm)
    // is pinned as a DB-level invariant via the `material.consumed` ledger row's
    // `weightConsumed` payload field. Phase B persists this; Phase C uses the
    // same value (in-memory backfill, see consumption-emitter.ts:370) so they
    // share the source of truth. The dispatch_jobs.materialsUsed JSON column
    // is intentionally NOT mutated in-place — the ledger is the canonical
    // record of consumption, materialsUsed remains the slicer-time snapshot.
    const measuredLedgerRows = await db
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.consumed'),
          eq(schema.ledgerEvents.provenanceClass, 'measured'),
          eq(schema.ledgerEvents.subjectId, materialId),
        ),
      );
    expect(measuredLedgerRows.length).toBeGreaterThanOrEqual(1);
    const measuredLedgerRow = measuredLedgerRows.find(
      (r: { payload: unknown }) => {
        const p = (typeof r.payload === 'string'
          ? JSON.parse(r.payload as string)
          : r.payload) as {
            attributedTo?: { jobId?: string; note?: string };
          };
        return (
          p.attributedTo?.jobId === dispatchJobId &&
          p.attributedTo?.note === 'slot:0'
        );
      },
    );
    expect(measuredLedgerRow).toBeDefined();
    const measuredPayload = (typeof measuredLedgerRow!.payload === 'string'
      ? JSON.parse(measuredLedgerRow!.payload as string)
      : measuredLedgerRow!.payload) as { weightConsumed: number };
    // ~19.98g back-calculated by T_b1 conversion — proves the conversion DB
    // chain (printer_loadouts → materials → filament_products) walked
    // correctly with density=1.24, diameter=1.75 from the catalog row.
    expect(measuredPayload.weightConsumed).toBeCloseTo(
      EXPECTED_KLIPPER_MEASURED_GRAMS,
      1,
    );

    // (c) dispatch_warnings has a row for divergence-detected
    const warnRows = await db.select().from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, dispatchJobId));
    expect(warnRows.length).toBeGreaterThanOrEqual(1);
    const warnRow = warnRows.find(
      (r: { errorCode: string; protocol: string; severity: string }) =>
        r.errorCode === 'divergence-detected' && r.protocol === 'forge-cf-5b',
    );
    expect(warnRow).toBeDefined();
    expect(warnRow!.severity).toBe('warning');

    // (d) dispatch_status_events has a 'warning' row for the divergence event
    const statusEvRows = await db.select().from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, dispatchJobId));
    const warningStatusRow = statusEvRows.find(
      (r: { eventKind: string }) => r.eventKind === 'warning',
    );
    expect(warningStatusRow).toBeDefined();

    // (e) logger.info captured the ratio for this dispatch job
    // ratio ≈ 19.98 / 50 = 0.3996 < 0.50 threshold
    const ratioLogCall = infoSpy.mock.calls.find(
      (args: unknown[]) => {
        const meta = args[0];
        return (
          typeof meta === 'object' &&
          meta !== null &&
          'dispatchJobId' in meta &&
          (meta as { dispatchJobId: string }).dispatchJobId === dispatchJobId &&
          'divergenceRatio' in meta
        );
      },
    );
    expect(ratioLogCall).toBeDefined();
    const loggedMeta = ratioLogCall![0] as { divergenceRatio: number };
    expect(loggedMeta.divergenceRatio).toBeCloseTo(
      EXPECTED_KLIPPER_MEASURED_GRAMS / CF5B_ESTIMATED_GRAMS,
      2,
    );

    // (f) The conversion was reported as catalog-sourced (proves the DB chain
    // was actually walked rather than falling back to PLA defaults).
    const catalogConvertCall = infoSpy.mock.calls.find(
      (args: unknown[]) => {
        const meta = args[0];
        const msg = args[1];
        return (
          typeof meta === 'object' &&
          meta !== null &&
          'filamentUsedMm' in meta &&
          (meta as { filamentUsedMm: number }).filamentUsedMm === 6700 &&
          'densitySource' in meta &&
          typeof msg === 'string' &&
          msg.includes('Klipper filament_used → grams converted')
        );
      },
    );
    expect(catalogConvertCall).toBeDefined();
    expect((catalogConvertCall![0] as { densitySource: string }).densitySource)
      .toBe('catalog');

    // (g) SSE bus received the warning event (captured via bus.subscribe)
    expect(busEventKinds).toContain('warning');

    // (h) terminal notification reached the worker
    expect(workerNotifyTerminalCalls).toBeGreaterThanOrEqual(1);
  });

  it('CF-5b — Klipper print with measured ≈ estimated does NOT trigger warning but logs ratio', async () => {
    // -----------------------------------------------------------------------
    // DB + migrations
    // -----------------------------------------------------------------------
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    process.env.DATABASE_URL = DB_URL;
    process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
    resetDbCache();
    await runMigrations(DB_URL);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;

    const infoSpy: MockInstance = vi.spyOn(logger, 'info');

    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-cf5b-klipper-ok-'));
    const gcodePath = path.join(tempDir, 'cube.gcode');
    await fsp.writeFile(gcodePath, SLICER_GCODE, 'utf8');

    const ownerId = uid();
    await db.insert(schema.user).values({
      id: ownerId, name: 'CF-5b no-warn user',
      email: `${ownerId}@cf5b-klipper-ok.test`,
      emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const stashRootId = uid();
    await db.insert(schema.stashRoots).values({
      id: stashRootId, ownerId, name: 'root', path: tempDir,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const collectionId = uid();
    await db.insert(schema.collections).values({
      id: collectionId, ownerId, name: 'cf5b-klipper-ok-c',
      pathTemplate: '{title|slug}', stashRootId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const lootId = uid();
    await db.insert(schema.loot).values({
      id: lootId, collectionId, title: 'CF-5b no-warn cube',
      tags: [], fileMissing: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const fileBuf = await fsp.readFile(gcodePath);
    const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
    const slicedFileId = uid();
    await db.insert(schema.lootFiles).values({
      id: slicedFileId, lootId, path: 'cube.gcode', format: 'gcode',
      size: fileBuf.length, hash: fileHash, origin: 'manual', createdAt: new Date(),
    });

    const printerId = uid();
    await db.insert(schema.printers).values({
      id: printerId, ownerId, kind: 'fdm_klipper', name: 'CF-5b Klipper ok',
      connectionConfig: { host: '192.168.1.50', port: 7125, scheme: 'http', requiresAuth: false, startPrint: true },
      active: true, createdAt: new Date(),
    });

    const matResult = await createMaterial(
      { ownerId, kind: 'filament_spool', brand: 'TestBrand', subtype: 'PLA',
        colors: ['#aabbcc'], colorPattern: 'solid', initialAmount: 1000, unit: 'g' },
      { dbUrl: DB_URL },
    );
    if (!matResult.ok) throw new Error(`createMaterial failed: ${matResult.reason}`);
    const materialId = matResult.material.id;

    // 16500mm × π × (1.75/2)² × 1.24 / 1000 ≈ 49.21g
    // ratio = 49.21 / 50 ≈ 0.98 — well above 0.50 threshold → no warning
    const KLIPPER_MEASURED_GRAMS = 49.21;
    const CF5B_ESTIMATED_GRAMS = 50;

    const dispatchJobId = uid();
    await db.insert(schema.dispatchJobs).values({
      id: dispatchJobId, ownerId, lootId, targetKind: 'printer', targetId: printerId,
      slicedFileId, status: 'dispatched',
      materialsUsed: [
        { slot_index: 0, material_id: materialId, estimated_grams: CF5B_ESTIMATED_GRAMS, measured_grams: null },
      ],
      createdAt: new Date(),
    });

    const stubRig = makeStubSubscriberRig('fdm_klipper');
    const subscriberRegistry = createSubscriberRegistry();
    subscriberRegistry.register('fdm_klipper', stubRig.factory);

    const bus = createStatusEventBus();

    let workerNotifyTerminalCalls = 0;
    // eslint-disable-next-line prefer-const
    let workerForCircular: ForgeStatusWorker;

    const persistWarningStatusEvent = async (args: {
      dispatchJobId: string;
      printerKind: string;
      printerId?: string;
      errorCode: string;
      protocol: string;
      severity: 'info' | 'warning' | 'error';
      message?: string;
      occurredAt: Date;
    }): Promise<void> => {
      const syntheticEvent = {
        kind: 'warning' as const,
        remoteJobRef: '',
        errorCode: args.errorCode,
        errorMessage: args.message,
        severity: args.severity,
        rawPayload: { source: 'cf-5b-divergence', protocol: args.protocol },
        occurredAt: args.occurredAt,
      };
      if (args.printerId) {
        await persistStatusEvent({
          printerId: args.printerId,
          dispatchJobId: args.dispatchJobId,
          printerKind: args.printerKind,
          event: syntheticEvent,
          dbUrl: DB_URL,
        });
      }
      bus.emit(args.dispatchJobId, syntheticEvent);
    };

    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        notifyTerminal: async (a) => {
          workerNotifyTerminalCalls += 1;
          await workerForCircular.notifyTerminal(a);
        },
        emitConsumption: async ({ dispatchJobId: jid, event, printerKind, printerId: pid }) => {
          await emitConsumptionForCompletion(
            { dispatchJobId: jid, event, printerKind, printerId: pid },
            { dbUrl: DB_URL, persistWarningStatusEvent },
          );
        },
        emitToBus: (jid, event) => { bus.emit(jid, event); },
      },
    });

    workerForCircular = createForgeStatusWorker({
      registry: subscriberRegistry,
      dbUrl: DB_URL,
      onEvent: (printerIdArg, event) => { void sink(printerIdArg, event); },
    });
    workerRef = workerForCircular;

    await workerForCircular.notifyDispatched({ dispatchJobId, printerId });
    await flushAsyncQueue();

    const baseTime = Date.now();
    stubRig.emit({
      kind: 'completed',
      remoteJobRef: 'cube.gcode',
      progressPct: 100,
      measuredConsumption: [{ slot_index: 0, grams: KLIPPER_MEASURED_GRAMS }],
      rawPayload: { phase: 'completed' },
      occurredAt: new Date(baseTime + 1000),
    });
    await flushAsyncQueue();
    await flushAsyncQueue();
    await flushAsyncQueue();

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    // (a) Job completed
    const jobRows = await db.select().from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, dispatchJobId));
    expect(jobRows[0]!.status).toBe('completed');

    // (b) NO dispatch_warnings row with divergence-detected for this job
    const warnRows = await db.select().from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, dispatchJobId));
    const divergenceWarnRow = warnRows.find(
      (r: { errorCode: string }) => r.errorCode === 'divergence-detected',
    );
    expect(divergenceWarnRow).toBeUndefined();

    // (c) logger.info still logged the ratio (always-log invariant)
    const ratioLogCall = infoSpy.mock.calls.find(
      (args: unknown[]) => {
        const meta = args[0];
        return (
          typeof meta === 'object' &&
          meta !== null &&
          'dispatchJobId' in meta &&
          (meta as { dispatchJobId: string }).dispatchJobId === dispatchJobId &&
          'divergenceRatio' in meta
        );
      },
    );
    expect(ratioLogCall).toBeDefined();
    const loggedMeta = ratioLogCall![0] as { divergenceRatio: number };
    expect(loggedMeta.divergenceRatio).toBeCloseTo(
      KLIPPER_MEASURED_GRAMS / CF5B_ESTIMATED_GRAMS,
      2,
    );

    expect(workerNotifyTerminalCalls).toBeGreaterThanOrEqual(1);
  });

  it('CF-5b multi-material (Bambu P1S) — aggregate ratio < 0.40 triggers warning', async () => {
    // -----------------------------------------------------------------------
    // DB + migrations
    // -----------------------------------------------------------------------
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    process.env.DATABASE_URL = DB_URL;
    process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
    resetDbCache();
    await runMigrations(DB_URL);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;

    // Bambu P1S is the natural multi-material test printer: AMS supplies per-
    // slot grams natively. 2 slots, 50g estimated each (100g total), measured
    // 10g + 20g (30g total) → ratio = 0.30 < 0.40 multi-material threshold.
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-cf5b-bambu-mm-'));
    const gcodePath = path.join(tempDir, 'cube.gcode');
    await fsp.writeFile(gcodePath, SLICER_GCODE, 'utf8');

    const ownerId = uid();
    await db.insert(schema.user).values({
      id: ownerId, name: 'CF-5b Bambu MM user',
      email: `${ownerId}@cf5b-bambu-mm.test`,
      emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const stashRootId = uid();
    await db.insert(schema.stashRoots).values({
      id: stashRootId, ownerId, name: 'root', path: tempDir,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const collectionId = uid();
    await db.insert(schema.collections).values({
      id: collectionId, ownerId, name: 'cf5b-bambu-mm-c',
      pathTemplate: '{title|slug}', stashRootId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const lootId = uid();
    await db.insert(schema.loot).values({
      id: lootId, collectionId, title: 'CF-5b Bambu MM cube',
      tags: [], fileMissing: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const fileBuf = await fsp.readFile(gcodePath);
    const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
    const slicedFileId = uid();
    await db.insert(schema.lootFiles).values({
      id: slicedFileId, lootId, path: 'cube.gcode', format: 'gcode',
      size: fileBuf.length, hash: fileHash, origin: 'manual', createdAt: new Date(),
    });

    // Bambu P1S — printerKind starts with 'bambu_' which isFdmKind accepts.
    const printerId = uid();
    await db.insert(schema.printers).values({
      id: printerId, ownerId, kind: 'bambu_p1s', name: 'CF-5b Bambu P1S',
      connectionConfig: { host: '192.168.1.51', serialNumber: 'BAMBU001', accessCode: 'code', startPrint: true },
      active: true, createdAt: new Date(),
    });

    // Two materials — one per AMS slot.
    const mat0Result = await createMaterial(
      { ownerId, kind: 'filament_spool', brand: 'BambuBrand', subtype: 'PLA',
        colors: ['#ff0000'], colorPattern: 'solid', initialAmount: 500, unit: 'g' },
      { dbUrl: DB_URL },
    );
    if (!mat0Result.ok) throw new Error(`createMaterial slot0 failed: ${mat0Result.reason}`);
    const materialId0 = mat0Result.material.id;

    const mat1Result = await createMaterial(
      { ownerId, kind: 'filament_spool', brand: 'BambuBrand', subtype: 'PLA',
        colors: ['#0000ff'], colorPattern: 'solid', initialAmount: 500, unit: 'g' },
      { dbUrl: DB_URL },
    );
    if (!mat1Result.ok) throw new Error(`createMaterial slot1 failed: ${mat1Result.reason}`);
    const materialId1 = mat1Result.material.id;

    // 2 slots × 50g estimated = 100g total estimated.
    const dispatchJobId = uid();
    await db.insert(schema.dispatchJobs).values({
      id: dispatchJobId, ownerId, lootId, targetKind: 'printer', targetId: printerId,
      slicedFileId, status: 'dispatched',
      materialsUsed: [
        { slot_index: 0, material_id: materialId0, estimated_grams: 50, measured_grams: null },
        { slot_index: 1, material_id: materialId1, estimated_grams: 50, measured_grams: null },
      ],
      createdAt: new Date(),
    });

    const stubRig = makeStubSubscriberRig('bambu_p1s');
    const subscriberRegistry = createSubscriberRegistry();
    subscriberRegistry.register('bambu_p1s', stubRig.factory);

    const bus = createStatusEventBus();
    const busEventKindsMM: string[] = [];
    let busUnsubMM: (() => void) | null = null;

    let workerNotifyTerminalCalls = 0;
    // eslint-disable-next-line prefer-const
    let workerForCircular: ForgeStatusWorker;

    const persistWarningStatusEvent = async (args: {
      dispatchJobId: string;
      printerKind: string;
      printerId?: string;
      errorCode: string;
      protocol: string;
      severity: 'info' | 'warning' | 'error';
      message?: string;
      occurredAt: Date;
    }): Promise<void> => {
      const syntheticEvent = {
        kind: 'warning' as const,
        remoteJobRef: '',
        errorCode: args.errorCode,
        errorMessage: args.message,
        severity: args.severity,
        rawPayload: { source: 'cf-5b-divergence', protocol: args.protocol },
        occurredAt: args.occurredAt,
      };
      if (args.printerId) {
        await persistStatusEvent({
          printerId: args.printerId,
          dispatchJobId: args.dispatchJobId,
          printerKind: args.printerKind,
          event: syntheticEvent,
          dbUrl: DB_URL,
        });
      }
      bus.emit(args.dispatchJobId, syntheticEvent);
    };

    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        notifyTerminal: async (a) => {
          workerNotifyTerminalCalls += 1;
          await workerForCircular.notifyTerminal(a);
        },
        emitConsumption: async ({ dispatchJobId: jid, event, printerKind, printerId: pid }) => {
          await emitConsumptionForCompletion(
            { dispatchJobId: jid, event, printerKind, printerId: pid },
            { dbUrl: DB_URL, persistWarningStatusEvent },
          );
        },
        // All bus emits (including emitToBus) are captured via the single
        // bus.subscribe below; don't push here too (would double-count).
        emitToBus: (jid, event) => {
          bus.emit(jid, event);
        },
      },
    });

    // Subscribe to capture ALL bus emits — emitToBus AND persistWarningStatusEvent.
    busUnsubMM = bus.subscribe(dispatchJobId, (event) => {
      busEventKindsMM.push(event.kind);
    });
    cleanupFns.push(async () => { busUnsubMM?.(); });

    workerForCircular = createForgeStatusWorker({
      registry: subscriberRegistry,
      dbUrl: DB_URL,
      onEvent: (printerIdArg, event) => { void sink(printerIdArg, event); },
    });
    workerRef = workerForCircular;

    await workerForCircular.notifyDispatched({ dispatchJobId, printerId });
    await flushAsyncQueue();

    // Drive Bambu terminal event: slot 0=10g, slot 1=20g (total 30g measured vs 100g estimated = 0.30 ratio).
    // ratio 0.30 < 0.40 multi-material threshold → warning expected.
    const baseTime = Date.now();
    stubRig.emit({
      kind: 'completed',
      remoteJobRef: 'cube.gcode',
      progressPct: 100,
      measuredConsumption: [
        { slot_index: 0, grams: 10 },
        { slot_index: 1, grams: 20 },
      ],
      rawPayload: { phase: 'completed' },
      occurredAt: new Date(baseTime + 1000),
    });
    await flushAsyncQueue();
    await flushAsyncQueue();
    await flushAsyncQueue();

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    // (a) Job completed
    const jobRows = await db.select().from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, dispatchJobId));
    expect(jobRows[0]!.status).toBe('completed');

    // (b) dispatch_warnings has a row for divergence-detected
    const warnRows = await db.select().from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, dispatchJobId));
    expect(warnRows.length).toBeGreaterThanOrEqual(1);
    const warnRow = warnRows.find(
      (r: { errorCode: string; protocol: string; severity: string }) =>
        r.errorCode === 'divergence-detected' && r.protocol === 'forge-cf-5b',
    );
    expect(warnRow).toBeDefined();
    expect(warnRow!.severity).toBe('warning');

    // (c) dispatch_status_events has a 'warning' row
    const statusEvRows = await db.select().from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, dispatchJobId));
    const warningStatusRow = statusEvRows.find(
      (r: { eventKind: string }) => r.eventKind === 'warning',
    );
    expect(warningStatusRow).toBeDefined();

    // (d) SSE bus received the warning (captured via bus.subscribe)
    expect(busEventKindsMM).toContain('warning');

    expect(workerNotifyTerminalCalls).toBeGreaterThanOrEqual(1);
  });

  it('CF-5b skips divergence check for SDCP (resin) printer kind', async () => {
    // -----------------------------------------------------------------------
    // DB + migrations
    // -----------------------------------------------------------------------
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    process.env.DATABASE_URL = DB_URL;
    process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
    resetDbCache();
    await runMigrations(DB_URL);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;

    // Spy on logger.info to confirm NO ratio log for SDCP prints.
    const infoSpy: MockInstance = vi.spyOn(logger, 'info');

    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-cf5b-sdcp-'));
    const gcodePath = path.join(tempDir, 'cube.gcode');
    await fsp.writeFile(gcodePath, SLICER_GCODE, 'utf8');

    const ownerId = uid();
    await db.insert(schema.user).values({
      id: ownerId, name: 'CF-5b SDCP user',
      email: `${ownerId}@cf5b-sdcp.test`,
      emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const stashRootId = uid();
    await db.insert(schema.stashRoots).values({
      id: stashRootId, ownerId, name: 'root', path: tempDir,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const collectionId = uid();
    await db.insert(schema.collections).values({
      id: collectionId, ownerId, name: 'cf5b-sdcp-c',
      pathTemplate: '{title|slug}', stashRootId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const lootId = uid();
    await db.insert(schema.loot).values({
      id: lootId, collectionId, title: 'CF-5b SDCP cube',
      tags: [], fileMissing: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const fileBuf = await fsp.readFile(gcodePath);
    const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
    const slicedFileId = uid();
    await db.insert(schema.lootFiles).values({
      id: slicedFileId, lootId, path: 'cube.gcode', format: 'gcode',
      size: fileBuf.length, hash: fileHash, origin: 'manual', createdAt: new Date(),
    });

    // SDCP resin printer — does NOT start with 'fdm_klipper' or 'bambu_'.
    // isFdmKind('sdcp_elegoo_saturn_4') === false → Phase C is skipped.
    const printerId = uid();
    await db.insert(schema.printers).values({
      id: printerId, ownerId, kind: 'sdcp_elegoo_saturn_4', name: 'CF-5b SDCP Saturn 4',
      connectionConfig: { host: '192.168.1.60', port: 3000, scheme: 'http', requiresAuth: false },
      active: true, createdAt: new Date(),
    });

    const matResult = await createMaterial(
      { ownerId, kind: 'resin_bottle', brand: 'Elegoo', subtype: 'ABS-Like',
        colors: ['#888888'], colorPattern: 'solid', initialAmount: 500, unit: 'ml' },
      { dbUrl: DB_URL },
    );
    if (!matResult.ok) throw new Error(`createMaterial failed: ${matResult.reason}`);
    const materialId = matResult.material.id;

    const dispatchJobId = uid();
    await db.insert(schema.dispatchJobs).values({
      id: dispatchJobId, ownerId, lootId, targetKind: 'printer', targetId: printerId,
      slicedFileId, status: 'dispatched',
      materialsUsed: [
        { slot_index: 0, material_id: materialId, estimated_grams: 50, measured_grams: null },
      ],
      createdAt: new Date(),
    });

    const stubRig = makeStubSubscriberRig('sdcp_elegoo_saturn_4');
    const subscriberRegistry = createSubscriberRegistry();
    subscriberRegistry.register('sdcp_elegoo_saturn_4', stubRig.factory);

    const bus = createStatusEventBus();

    let workerNotifyTerminalCalls = 0;
    // eslint-disable-next-line prefer-const
    let workerForCircular: ForgeStatusWorker;

    const persistWarningStatusEvent = async (args: {
      dispatchJobId: string;
      printerKind: string;
      printerId?: string;
      errorCode: string;
      protocol: string;
      severity: 'info' | 'warning' | 'error';
      message?: string;
      occurredAt: Date;
    }): Promise<void> => {
      const syntheticEvent = {
        kind: 'warning' as const,
        remoteJobRef: '',
        errorCode: args.errorCode,
        errorMessage: args.message,
        severity: args.severity,
        rawPayload: { source: 'cf-5b-divergence', protocol: args.protocol },
        occurredAt: args.occurredAt,
      };
      if (args.printerId) {
        await persistStatusEvent({
          printerId: args.printerId,
          dispatchJobId: args.dispatchJobId,
          printerKind: args.printerKind,
          event: syntheticEvent,
          dbUrl: DB_URL,
        });
      }
      bus.emit(args.dispatchJobId, syntheticEvent);
    };

    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        notifyTerminal: async (a) => {
          workerNotifyTerminalCalls += 1;
          await workerForCircular.notifyTerminal(a);
        },
        emitConsumption: async ({ dispatchJobId: jid, event, printerKind, printerId: pid }) => {
          await emitConsumptionForCompletion(
            { dispatchJobId: jid, event, printerKind, printerId: pid },
            { dbUrl: DB_URL, persistWarningStatusEvent },
          );
        },
        emitToBus: (jid, event) => { bus.emit(jid, event); },
      },
    });

    workerForCircular = createForgeStatusWorker({
      registry: subscriberRegistry,
      dbUrl: DB_URL,
      onEvent: (printerIdArg, event) => { void sink(printerIdArg, event); },
    });
    workerRef = workerForCircular;

    await workerForCircular.notifyDispatched({ dispatchJobId, printerId });
    await flushAsyncQueue();

    // Drive SDCP completed event — no measuredConsumption (resin printers
    // don't report per-slot filament usage). Phase B is a no-op (empty
    // measuredConsumption). Phase C is skipped by isFdmKind gate.
    const baseTime = Date.now();
    stubRig.emit({
      kind: 'completed',
      remoteJobRef: 'cube.ctb',
      progressPct: 100,
      measuredConsumption: [],
      rawPayload: { phase: 'completed' },
      occurredAt: new Date(baseTime + 1000),
    });
    await flushAsyncQueue();
    await flushAsyncQueue();
    await flushAsyncQueue();

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    // (a) Job completed (state machine still drives to completed)
    const jobRows = await db.select().from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, dispatchJobId));
    expect(jobRows[0]!.status).toBe('completed');

    // (b) NO dispatch_warnings row for this job (isFdmKind gate skips Phase C)
    const warnRows = await db.select().from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, dispatchJobId));
    expect(warnRows.length).toBe(0);

    // (c) NO dispatch_status_events 'warning' row
    const statusEvRows = await db.select().from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, dispatchJobId));
    const warningStatusRow = statusEvRows.find(
      (r: { eventKind: string }) => r.eventKind === 'warning',
    );
    expect(warningStatusRow).toBeUndefined();

    // (d) NO 'cf-5b: divergence ratio recorded' log line for this dispatch job.
    // Proves the isFdmKind gate fires BEFORE the ratio log in runDivergenceCheck.
    const ratioLogCall = infoSpy.mock.calls.find(
      (args: unknown[]) => {
        const meta = args[0];
        return (
          typeof meta === 'object' &&
          meta !== null &&
          'dispatchJobId' in meta &&
          (meta as { dispatchJobId: string }).dispatchJobId === dispatchJobId &&
          'divergenceRatio' in meta
        );
      },
    );
    expect(ratioLogCall).toBeUndefined();

    expect(workerNotifyTerminalCalls).toBeGreaterThanOrEqual(1);
  });
});
