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
import { createMaterial } from '../../src/materials/lifecycle';
import {
  createSubscriberRegistry,
  resetDefaultSubscriberRegistry,
  type StatusSubscriberFactory,
} from '../../src/forge/status/registry';
import {
  createStatusEventBus,
  resetDefaultStatusEventBus,
} from '../../src/forge/status/event-bus';
import { createStatusEventSink } from '../../src/forge/status/status-event-handler';
import { emitConsumptionForCompletion } from '../../src/forge/status/consumption-emitter';
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
});
