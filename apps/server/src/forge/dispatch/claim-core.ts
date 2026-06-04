/**
 * claim-core.ts — V2-006a-T3
 *
 * Shared claim-core logic used by BOTH the in-process forge-claim-worker (T4)
 * AND the upcoming HTTP Courier claim endpoint (T6).
 *
 * Exports:
 *   - ClaimableCandidate      interface
 *   - PrinterRow              interface
 *   - ArtifactRow             interface (extended with mimeType for T6 bundle)
 *   - findClaimableCandidate  — two-query slicer+printer candidate selector
 *   - extractAndPersistSlicerEstimate — Phase-A slicer estimate + materials_used cache
 *   - loadPrinterForJob       — printer row loader
 *   - loadArtifactForJob      — artifact row loader (includes mimeType)
 *   - buildExecutionBundle    — assemble everything a remote Courier needs to execute
 *
 * This module has NO side-effects on import. All functions are pure I/O
 * against the database + file system (via extractSlicerEstimate). No worker
 * lifecycle state lives here.
 */

import { and, asc, eq } from 'drizzle-orm';

import { logger } from '../../logger';
import { getServerDb, schema } from '../../db/client';
import type { DispatchTargetKind, MaterialsUsed } from '../../db/schema.forge';
import { getCredential } from './credentials';
import type { DecryptedCredential } from './credentials';
import { extractSlicerEstimate } from './slicer-estimate/extractor';
import { emitConsumptionForDispatch } from '../status/consumption-emitter';
import { getCurrentLoadout } from '../loadouts/queries';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ClaimableCandidate {
  id: string;
  ownerId: string;
  lootId: string;
  targetKind: DispatchTargetKind;
  targetId: string;
}

export interface PrinterRow {
  id: string;
  ownerId: string;
  kind: string;
  connectionConfig: unknown;
}

export interface ArtifactRow {
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string | null;
}

// ---------------------------------------------------------------------------
// findClaimableCandidate
// ---------------------------------------------------------------------------

/**
 * SELECT the oldest claimable job reachable by `agentId`.
 *
 * Reachability filter:
 *   - slicer-target jobs are ALWAYS reachable by the central worker.
 *   - printer-target jobs are reachable iff a row exists in
 *     printer_reachable_via with (printer_id = target_id, agent_id = X).
 *
 * Returns null when no candidate exists. Caller still has to win the race
 * via markClaimed (the SELECT is unguarded — concurrent tickers may pick
 * the same row, and the WHERE on markClaimed serialises them).
 */
export async function findClaimableCandidate(
  agentId: string,
  dbUrl?: string,
): Promise<ClaimableCandidate | null> {
  const db = getServerDb(dbUrl);
  // Drizzle's left-join + OR query is awkward to express type-safely against
  // an `and(eq(...), eq(...))` JOIN-on clause; we fall back to two queries
  // and merge in app-layer per the task brief's pragmatic guidance. Each
  // query orders by createdAt ASC and limits to 1; we pick the older of the
  // two candidates.

  // Query 1: slicer-target claimable jobs.
  const slicerRows = await db
    .select({
      id: schema.dispatchJobs.id,
      ownerId: schema.dispatchJobs.ownerId,
      lootId: schema.dispatchJobs.lootId,
      targetKind: schema.dispatchJobs.targetKind,
      targetId: schema.dispatchJobs.targetId,
      createdAt: schema.dispatchJobs.createdAt,
    })
    .from(schema.dispatchJobs)
    .where(
      and(
        eq(schema.dispatchJobs.status, 'claimable'),
        eq(schema.dispatchJobs.targetKind, 'slicer'),
      ),
    )
    .orderBy(asc(schema.dispatchJobs.createdAt))
    .limit(1);

  // Query 2: printer-target claimable jobs reachable by this agent.
  const printerRows = await db
    .select({
      id: schema.dispatchJobs.id,
      ownerId: schema.dispatchJobs.ownerId,
      lootId: schema.dispatchJobs.lootId,
      targetKind: schema.dispatchJobs.targetKind,
      targetId: schema.dispatchJobs.targetId,
      createdAt: schema.dispatchJobs.createdAt,
    })
    .from(schema.dispatchJobs)
    .innerJoin(
      schema.printerReachableVia,
      and(
        eq(schema.printerReachableVia.printerId, schema.dispatchJobs.targetId),
        eq(schema.printerReachableVia.agentId, agentId),
      ),
    )
    .where(
      and(
        eq(schema.dispatchJobs.status, 'claimable'),
        eq(schema.dispatchJobs.targetKind, 'printer'),
      ),
    )
    .orderBy(asc(schema.dispatchJobs.createdAt))
    .limit(1);

  const slicer = slicerRows[0];
  const printer = printerRows[0];

  // Pick the older of the two (oldest claimable across kinds wins).
  let pick: typeof slicer | undefined;
  if (slicer && printer) {
    pick = slicer.createdAt <= printer.createdAt ? slicer : printer;
  } else {
    pick = slicer ?? printer;
  }

  if (!pick) return null;
  return {
    id: pick.id,
    ownerId: pick.ownerId,
    lootId: pick.lootId,
    targetKind: pick.targetKind as DispatchTargetKind,
    targetId: pick.targetId,
  };
}

// ---------------------------------------------------------------------------
// loadPrinterForJob
// ---------------------------------------------------------------------------

export async function loadPrinterForJob(
  printerId: string,
  dbUrl?: string,
): Promise<PrinterRow | null> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({
      id: schema.printers.id,
      ownerId: schema.printers.ownerId,
      kind: schema.printers.kind,
      connectionConfig: schema.printers.connectionConfig,
    })
    .from(schema.printers)
    .where(eq(schema.printers.id, printerId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// loadArtifactForJob
// ---------------------------------------------------------------------------

export async function loadArtifactForJob(
  jobId: string,
  dbUrl?: string,
): Promise<ArtifactRow | null> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({
      storagePath: schema.forgeArtifacts.storagePath,
      sizeBytes: schema.forgeArtifacts.sizeBytes,
      sha256: schema.forgeArtifacts.sha256,
      mimeType: schema.forgeArtifacts.mimeType,
    })
    .from(schema.forgeArtifacts)
    .where(eq(schema.forgeArtifacts.dispatchJobId, jobId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// extractAndPersistSlicerEstimate
// ---------------------------------------------------------------------------

/**
 * V2-005f-T_dcf11 Phase A. After claim, before dispatch handler runs:
 *
 *   1. Resolve the dispatch's machine-facing artifact storage path
 *      (forge_artifacts.storage_path — set by V2-005c slicer worker for
 *      printer-target jobs). Slicer-target jobs and pre-slice jobs have no
 *      artifact yet → no-op.
 *   2. Run `extractSlicerEstimate` against that path. Parser failures and
 *      unsupported formats return null (the framework swallows throws).
 *   3. Look up the printer's current loadout via getCurrentLoadout — map
 *      slot_index → material_id (V2-005f-CF-1 T_g4). Slots without a loaded
 *      material log a warning and ship `material_id: ''` so Phase B safely
 *      skips emission for those slots.
 *   4. UPDATE `dispatch_jobs.materials_used` with the per-slot estimate.
 *   5. Call `emitConsumptionForDispatch` to record the Phase-A estimated
 *      ledger row(s). Slots with empty material_id are skipped by the
 *      emitter; slots with a real material_id produce ledger rows.
 *
 * Best-effort. Failures are logged and swallowed — dispatch continues
 * regardless. The materials_used cache is purely metadata + bookkeeping
 * for Phase B; missing data degrades the consumption-event flow but does
 * not break the print.
 */
export async function extractAndPersistSlicerEstimate(args: {
  dispatchJobId: string;
  lootId: string;
  printerId: string;
  dbUrl?: string;
}): Promise<void> {
  const artifact = await loadArtifactForJob(args.dispatchJobId, args.dbUrl);
  if (!artifact) {
    // No machine-facing artifact yet — slicer-target jobs and jobs that
    // skipped the slicer worker land here. Nothing to extract.
    return;
  }

  const estimate = await extractSlicerEstimate({ filePath: artifact.storagePath }).catch(
    () => null,
  );
  if (!estimate) {
    logger.debug(
      { dispatchJobId: args.dispatchJobId, path: artifact.storagePath },
      'forge-claim: slicer estimate not extractable — skipping Phase A',
    );
    return;
  }

  // V2-005f-CF-1 T_g4: resolve material_id per slot from the printer's current
  // open loadout. Unmatched slots fall through to material_id='' + warning;
  // Phase B's emitter skips empty material_ids.
  const loadout = await getCurrentLoadout(args.printerId, { dbUrl: args.dbUrl });
  const loadoutBySlot = new Map(loadout.map((l) => [l.slotIndex, l.materialId]));

  const materialsUsed: MaterialsUsed = estimate.slots.map((s) => {
    const material_id = loadoutBySlot.get(s.slot_index) ?? '';
    if (material_id === '') {
      logger.warn(
        {
          printerId: args.printerId,
          slotIndex: s.slot_index,
          dispatchJobId: args.dispatchJobId,
        },
        'forge-claim: slicer-estimate references slot with no loaded material — consumption will skip this slot',
      );
    }
    return {
      slot_index: s.slot_index,
      material_id,
      estimated_grams: s.estimated_grams,
      measured_grams: null,
    };
  });

  const db = getServerDb(args.dbUrl);
  // better-sqlite3 needs `.run()` to actually execute (the awaited builder is
  // only the async-postgres path). Mirror dispatch-state.ts's pattern.
  (db
    .update(schema.dispatchJobs)
    .set({ materialsUsed })
    .where(eq(schema.dispatchJobs.id, args.dispatchJobId)) as unknown as {
    run: () => unknown;
  }).run();

  // Phase A emission. Currently a no-op (every material_id is '') — the
  // call site is here so V2-005f-CF-1 can flip the switch by populating
  // material_id without touching this worker.
  await emitConsumptionForDispatch(
    {
      dispatchJobId: args.dispatchJobId,
      lootId: args.lootId,
      materialsUsed,
    },
    { dbUrl: args.dbUrl },
  );
}

// ---------------------------------------------------------------------------
// buildExecutionBundle
// ---------------------------------------------------------------------------

/**
 * Assemble everything a remote Courier agent needs to execute a claimed job.
 *
 * Pure assembly — no state transitions, no side effects. Reuses loadPrinterForJob,
 * loadArtifactForJob, and getCredential. `connectionConfig` is parsed from JSON
 * if the column returns a string (mirrors the worker's defensive handling).
 */
export interface ExecutionBundle {
  job: {
    id: string;
    ownerId: string;
    lootId: string;
    targetKind: DispatchTargetKind;
    targetId: string;
  };
  printer: {
    id: string;
    ownerId: string;
    kind: string;
    connectionConfig: Record<string, unknown>;
  } | null;
  credential: DecryptedCredential | null;
  artifact: {
    jobId: string;
    storagePath: string;
    sizeBytes: number;
    sha256: string;
    mimeType: string | null;
  } | null;
}

export async function buildExecutionBundle(
  jobId: string,
  dbUrl?: string,
): Promise<ExecutionBundle> {
  const db = getServerDb(dbUrl);

  // Load the dispatch job row.
  const jobRows = await db
    .select({
      id: schema.dispatchJobs.id,
      ownerId: schema.dispatchJobs.ownerId,
      lootId: schema.dispatchJobs.lootId,
      targetKind: schema.dispatchJobs.targetKind,
      targetId: schema.dispatchJobs.targetId,
    })
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, jobId))
    .limit(1);
  const jobRow = jobRows[0];

  if (!jobRow) {
    return {
      job: {
        id: jobId,
        ownerId: '',
        lootId: '',
        targetKind: 'printer',
        targetId: '',
      },
      printer: null,
      credential: null,
      artifact: null,
    };
  }

  const job = {
    id: jobRow.id,
    ownerId: jobRow.ownerId,
    lootId: jobRow.lootId,
    targetKind: jobRow.targetKind as DispatchTargetKind,
    targetId: jobRow.targetId,
  };

  // Load printer (only meaningful for printer-target jobs).
  let printer: ExecutionBundle['printer'] = null;
  if (job.targetKind === 'printer') {
    const printerRow = await loadPrinterForJob(job.targetId, dbUrl);
    if (printerRow) {
      printer = {
        id: printerRow.id,
        ownerId: printerRow.ownerId,
        kind: printerRow.kind,
        connectionConfig:
          typeof printerRow.connectionConfig === 'string'
            ? (JSON.parse(printerRow.connectionConfig) as Record<string, unknown>)
            : (printerRow.connectionConfig as Record<string, unknown>),
      };
    }
  }

  // Load credential (NULL when no row exists).
  let credential: DecryptedCredential | null = null;
  if (job.targetKind === 'printer') {
    try {
      credential = getCredential({ printerId: job.targetId, dbUrl });
    } catch {
      // Credential decryption failures produce null; the Courier endpoint
      // decides how to handle the absence (likely → dispatch fails).
      credential = null;
    }
  }

  // Load artifact.
  const artifactRow = await loadArtifactForJob(jobId, dbUrl);
  const artifact = artifactRow
    ? {
        jobId,
        storagePath: artifactRow.storagePath,
        sizeBytes: artifactRow.sizeBytes,
        sha256: artifactRow.sha256,
        mimeType: artifactRow.mimeType,
      }
    : null;

  return { job, printer, credential, artifact };
}
