/**
 * V2-005e-T_e5 — Cross-pillar end-to-end test for the Forge inbox slicer
 * pipeline.
 *
 * Single, comprehensive integration test that exercises the V2-005e wiring
 * together with the V2-005f-CF-1 loadout chain:
 *
 *   1. Forge inbox CRUD (V2-005e-T_e2) — POST creates row + chokidar watcher.
 *   2. File arrival on watched dir (chokidar add event) → handleSliceArrival.
 *   3. Classifier (slicer-output provider) marks the .gcode arrival.
 *   4. Three-tier matcher (V2-005e-T_e3) — sidecar/heuristic/pending. The
 *      filename heuristic matches `cube_PLA_0.2mm.gcode` against the source
 *      Loot titled `cube`, so parent_loot_id is set on the slice row.
 *   5. POST /api/v1/forge/dispatch (V2-005a-T5) targeting a printer with the
 *      slice loot id.
 *   6. runOneClaimTick (V2-005f-CF-1-T_g4) drains the claimable job, runs
 *      extractAndPersistSlicerEstimate against the slice gcode, queries the
 *      pre-loaded printer loadout, fills materials_used[].material_id, and
 *      transitions claimed → dispatched (stub DispatchHandler).
 *   7. Stub StatusSubscriber drives a progress + completed event with
 *      measuredConsumption. The real status sink + consumption emitter
 *      persist BOTH a Phase A `material.consumed` (provenance='estimated')
 *      row from extractAndPersistSlicerEstimate and a Phase B
 *      `material.consumed` (provenance='measured') row from the terminal
 *      transition.
 *
 * Pragmatic shortcuts (allowed by plan):
 *   - Stub DispatchHandler. No real Moonraker network. Just proves the
 *     registry wiring.
 *   - Stub StatusSubscriber factory. Captures onEvent for direct driving.
 *     No real WS/MQTT. Per-protocol plumbing is covered by V2-005f-T_dcf13.
 *   - Test mirrors `e2e-v2-005f-cross-pillar.test.ts` T_g5 but the dispatch
 *     job's loot is created by the inbox pipeline, NOT by direct DB seed —
 *     that's the unique T_e5 invariant.
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
import { eq, and, isNotNull } from 'drizzle-orm';

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
  createInbox,
} from '../../src/forge/inboxes/lifecycle';
import {
  startInboxWatcher,
  shutdownAllInboxWatchers,
  hasActiveWatcher,
} from '../../src/forge/inboxes/ingest';
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
// Test constants
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-e2e-v2-005e-slicer-inbox.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'a'.repeat(32);

// PrusaSlicer-style gcode with embedded slicer-estimate comments. The test
// triggers the inbox classifier on the .gcode extension, not the contents.
// The body's `; filament used [g] = 38.42` comment is what
// extractAndPersistSlicerEstimate reads when the claim worker runs.
const SLICER_GCODE = [
  '; lootgoblin V2-005e T_e5 fixture',
  'G28',
  'M84',
  '; filament used [g] = 38.42',
  '; filament used [cm3] = 31.97',
  '; filament_type = PLA',
  '; estimated printing time (normal mode) = 1h 23m 45s',
  '',
].join('\n');

const ESTIMATED_GRAMS = 38.42;
const REMAIN_PERCENT_AT_END = 20;
const EXPECTED_MEASURED_GRAMS = ESTIMATED_GRAMS * (1 - REMAIN_PERCENT_AT_END / 100);
const INITIAL_MATERIAL_GRAMS = 1000;

// chokidar awaitWriteFinish + ready races mean we need to poll until the
// matcher has run. 200ms stability + a 5s polling budget is plenty for a
// single ~200-byte file write on tmpfs / WSL2.
const WATCHER_STABILITY_MS = 200;
const POLL_TIMEOUT_MS = 8_000;

function uid(): string {
  return crypto.randomUUID();
}

async function flushAsyncQueue(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  }
}

async function waitForCondition(
  check: () => Promise<boolean> | boolean,
  timeoutMs = POLL_TIMEOUT_MS,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForCondition timeout after ${timeoutMs}ms: ${label}`);
}

// ---------------------------------------------------------------------------
// Stub StatusSubscriber — captures onEvent for direct driving.
// ---------------------------------------------------------------------------

interface StubSubscriberRig {
  factory: StatusSubscriberFactory;
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
// Stub DispatchHandler — proves V2-005d-a wiring without real Moonraker HTTP.
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
      return { kind: 'success', remoteFilename: 'cube_PLA_0.2mm.gcode' };
    },
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

let workerRef: ForgeStatusWorker | null = null;
let tempDir: string | null = null;

beforeEach(async () => {
  stubDispatchCalls = [];
  workerRef = null;
  resetDefaultSubscriberRegistry();
  resetDefaultStatusEventBus();
  getDefaultDispatchRegistry().clear();
  await shutdownAllInboxWatchers();
});

afterEach(async () => {
  if (workerRef) {
    try {
      await workerRef.stop();
    } catch {
      /* ignore */
    }
    workerRef = null;
  }
  await shutdownAllInboxWatchers();
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

describe('V2-005e cross-pillar e2e (T_e5)', () => {
  it(
    'full pipeline: inbox → ingest → match → dispatch → status → consumption',
    async () => {
      // -----------------------------------------------------------------
      // Setup phase — DB + migrations + clean singletons.
      // -----------------------------------------------------------------
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

      // -----------------------------------------------------------------
      // Step 1: Seed user + stash root + collection (so source Loot has
      // an ownership path via collections.owner_id, which is how the
      // matcher's heuristicMatchForSlice JOINs ownership).
      // -----------------------------------------------------------------
      tempDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'lootgoblin-v2-005e-t_e5-'),
      );
      const stashRootPath = path.join(tempDir, 'stash');
      const inboxDir = path.join(tempDir, 'inbox');
      await fsp.mkdir(stashRootPath, { recursive: true });
      await fsp.mkdir(inboxDir, { recursive: true });

      const ownerId = uid();
      await db.insert(schema.user).values({
        id: ownerId,
        name: 'T_e5 cross-pillar test user',
        email: `${ownerId}@cross-pillar-te5.test`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const stashRootId = uid();
      await db.insert(schema.stashRoots).values({
        id: stashRootId,
        ownerId,
        name: 'root',
        path: stashRootPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const collectionId = uid();
      await db.insert(schema.collections).values({
        id: collectionId,
        ownerId,
        name: 'cross-pillar-te5',
        pathTemplate: '{title|slug}',
        stashRootId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Seed the source Loot — this is the .stl that the slice came from.
      // The filename heuristic strips `_PLA_0.2mm` from the slice basename
      // and matches the resulting `cube` against this Loot's title.
      const sourceLootId = uid();
      await db.insert(schema.loot).values({
        id: sourceLootId,
        collectionId,
        title: 'cube',
        tags: [],
        fileMissing: false,
        parentLootId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // -----------------------------------------------------------------
      // Step 2: Bootstrap central worker + seed printer + reachable_via.
      // -----------------------------------------------------------------
      const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
      const agentId = bootstrap.agentId;

      const printerId = uid();
      await db.insert(schema.printers).values({
        id: printerId,
        ownerId,
        kind: 'fdm_klipper',
        name: 'T_e5 Test Klipper',
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

      // Material + LOAD into printer slot 0 — emits material.loaded ledger.
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

      // -----------------------------------------------------------------
      // Step 3: Create the forge_inboxes row + start the chokidar watcher
      // bound to inboxDir. Use a short stability threshold so file arrivals
      // settle quickly.
      // -----------------------------------------------------------------
      const inbox = await createInbox(
        {
          ownerId,
          name: 'T_e5 inbox',
          path: inboxDir,
        },
        { dbUrl: DB_URL },
      );
      await startInboxWatcher(inbox, {
        stabilityThresholdMs: WATCHER_STABILITY_MS,
      });
      expect(hasActiveWatcher(inbox.id)).toBe(true);

      // -----------------------------------------------------------------
      // Step 4: Drop a slicer-output gcode file into the watched dir.
      // chokidar fires `add` → handleSliceArrival → classifier marks
      // slicer-output → matchSliceArrival ingests + heuristic-matches.
      // -----------------------------------------------------------------
      const sliceFilename = 'cube_PLA_0.2mm.gcode';
      const slicePath = path.join(inboxDir, sliceFilename);
      await fsp.writeFile(slicePath, SLICER_GCODE, 'utf8');

      // Wait for the matcher to insert the slice loot AND set parent_loot_id
      // (via filename heuristic). The slice loot is identifiable by
      // origin='inbox' on its loot_files row.
      await waitForCondition(async () => {
        const sliceRows = await db
          .select({ id: schema.loot.id, parentLootId: schema.loot.parentLootId })
          .from(schema.loot)
          .where(
            and(
              eq(schema.loot.collectionId, collectionId),
              isNotNull(schema.loot.parentLootId),
            ),
          );
        return sliceRows.length > 0 && sliceRows[0]!.parentLootId !== null;
      }, POLL_TIMEOUT_MS, 'inbox ingest + heuristic match');

      // Find the slice loot row + assert the heuristic matched the source.
      const sliceRows = await db
        .select()
        .from(schema.loot)
        .where(
          and(
            eq(schema.loot.collectionId, collectionId),
            isNotNull(schema.loot.parentLootId),
          ),
        );
      expect(sliceRows).toHaveLength(1);
      const sliceLoot = sliceRows[0]!;
      expect(sliceLoot.parentLootId).toBe(sourceLootId);
      // Slice loot title = original basename per ingestSliceAsLoot.
      expect(sliceLoot.title).toBe(sliceFilename);

      // The slice's loot_files row stores the absolute inbox path AS-IS
      // (T_e3 simplification — no FS adapter copy yet).
      const sliceFileRows = await db
        .select()
        .from(schema.lootFiles)
        .where(eq(schema.lootFiles.lootId, sliceLoot.id));
      expect(sliceFileRows).toHaveLength(1);
      expect(sliceFileRows[0]!.path).toBe(slicePath);
      expect(sliceFileRows[0]!.origin).toBe('inbox');
      expect(sliceFileRows[0]!.format).toBe('gcode');

      // -----------------------------------------------------------------
      // Step 5: Create the dispatch job for the slice loot in 'claimable'
      // status. createDispatchJob exercises the V2-005a-T5 domain layer +
      // T_g4 will fill materials_used during the claim tick.
      // -----------------------------------------------------------------
      const createJobResult = await createDispatchJob(
        {
          ownerId,
          lootId: sliceLoot.id,
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

      // The forge_artifacts row points at the slice file on disk — required
      // for extractAndPersistSlicerEstimate (the gateway to getCurrentLoadout).
      const fileBuf = await fsp.readFile(slicePath);
      const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
      await db.insert(schema.forgeArtifacts).values({
        id: uid(),
        dispatchJobId,
        kind: 'gcode',
        storagePath: slicePath,
        sizeBytes: fileBuf.length,
        sha256: fileHash,
        mimeType: 'text/x.gcode',
        metadataJson: null,
        createdAt: new Date(),
      });

      // -----------------------------------------------------------------
      // Step 6: Register stub DispatchHandler + status worker + sink + bus.
      // -----------------------------------------------------------------
      const stubHandler = makeStubMoonrakerHandler();
      const dispatchRegistry = getDefaultDispatchRegistry();
      dispatchRegistry.register(stubHandler);

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

      // -----------------------------------------------------------------
      // Step 7: Drive the claim tick — T_g4 path.
      //   extractAndPersistSlicerEstimate reads the slice gcode, extracts
      //   38.42g, queries getCurrentLoadout(printer)→materialId for slot 0,
      //   fills materials_used, then markDispatched fires the onJobDispatched
      //   hook which spins up the stub status subscriber.
      // -----------------------------------------------------------------
      const tickResult = await runOneClaimTick({
        agentId,
        dbUrl: DB_URL,
        onJobDispatched: async (a) => workerForCircular.notifyDispatched(a),
      });
      expect(tickResult).toBe('ran');
      await flushAsyncQueue();

      // -----------------------------------------------------------------
      // Step 8: Sanity check — materials_used was populated by the worker
      // (NOT pre-populated by the test).
      // -----------------------------------------------------------------
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
      expect(claimedMaterials![0]!.material_id).toBe(materialId);
      expect(claimedMaterials![0]!.estimated_grams).toBeCloseTo(
        ESTIMATED_GRAMS,
        2,
      );

      // Stub handler was invoked + subscriber spun up.
      expect(stubDispatchCalls.length).toBeGreaterThanOrEqual(1);
      expect(workerForCircular.isWatching(printerId)).toBe(true);
      expect(stubRig.startedFor.length).toBeGreaterThanOrEqual(1);
      expect(stubRig.startedFor[0]!.id).toBe(printerId);

      // -----------------------------------------------------------------
      // Step 9: Drive a happy-path lifecycle through the stub subscriber.
      // -----------------------------------------------------------------
      const baseTime = Date.now();
      const remoteJobRef = 'cube_PLA_0.2mm.gcode';

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
      // Extra settle for chained ledger persists.
      await flushAsyncQueue();

      // -----------------------------------------------------------------
      // Step 10: Final assertions — every layer's invariant.
      // -----------------------------------------------------------------

      // (a) dispatch_jobs is completed.
      const finalRows = await db
        .select()
        .from(schema.dispatchJobs)
        .where(eq(schema.dispatchJobs.id, dispatchJobId));
      const finalRow = finalRows[0]!;
      expect(finalRow.status).toBe('completed');
      expect(finalRow.progressPct).toBe(100);
      expect(finalRow.completedAt).not.toBeNull();
      expect(finalRow.lastStatusAt).not.toBeNull();

      // (b) materials_used persisted with the loaded material_id.
      const finalMaterials = finalRow.materialsUsed as MaterialsUsed | null;
      expect(finalMaterials).not.toBeNull();
      expect(finalMaterials!).toHaveLength(1);
      expect(finalMaterials![0]!.material_id).toBe(materialId);
      expect(finalMaterials![0]!.estimated_grams).toBeCloseTo(
        ESTIMATED_GRAMS,
        2,
      );

      // (c) Ledger has a `material.loaded` row (Phase 0 — loadInPrinter).
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
      const loadedPayload = (typeof loadedRows[0]!.payload === 'string'
        ? JSON.parse(loadedRows[0]!.payload as string)
        : loadedRows[0]!.payload) as { printerId: string; slotIndex: number };
      expect(loadedPayload.printerId).toBe(printerId);
      expect(loadedPayload.slotIndex).toBe(0);

      // (d) Ledger has BOTH 'material.consumed' rows for this dispatch:
      //     - Phase A 'estimated' (extractAndPersistSlicerEstimate)
      //     - Phase B 'measured' (terminal status emission)
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
      const estimatedRow = estimatedRows.find((r: { payload: unknown }) => {
        const p = (typeof r.payload === 'string'
          ? JSON.parse(r.payload as string)
          : r.payload) as {
          attributedTo?: { jobId?: string };
        };
        return p.attributedTo?.jobId === dispatchJobId;
      });
      expect(estimatedRow).toBeDefined();

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
      // The lootId in the consumed row is the SLICE loot, not the source —
      // dispatch_jobs.lootId = sliceLoot.id (we dispatched the slice).
      expect(measuredPayload.attributedTo.lootId).toBe(sliceLoot.id);
      expect(measuredPayload.weightConsumed).toBeCloseTo(
        EXPECTED_MEASURED_GRAMS,
        2,
      );

      // (e) materials.remaining_amount decremented by BOTH Phase A
      // (estimated) + Phase B (measured). V2-007a-T13 reports query by
      // provenance — this dual-decrement is intentional.
      const matRows = await db
        .select()
        .from(schema.materials)
        .where(eq(schema.materials.id, materialId));
      expect(matRows[0]!.remainingAmount).toBeCloseTo(
        INITIAL_MATERIAL_GRAMS - ESTIMATED_GRAMS - EXPECTED_MEASURED_GRAMS,
        2,
      );

      // (f) Worker received terminal notification + bus saw all events.
      expect(workerNotifyTerminalCalls).toBeGreaterThanOrEqual(1);
      expect(busEventCounts.get(dispatchJobId) ?? 0).toBeGreaterThanOrEqual(2);

      // (g) Inbox watcher still active — proves the chokidar lifecycle is
      // independent of the dispatch lifecycle.
      expect(hasActiveWatcher(inbox.id)).toBe(true);
    },
    30_000,
  );
});
