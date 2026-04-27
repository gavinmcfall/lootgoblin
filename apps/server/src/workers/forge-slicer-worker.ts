/**
 * Forge slicer worker — V2-005c-T_c10.
 *
 * Drains `dispatch_jobs WHERE status = 'slicing'` and runs the V2-005c
 * Prusa-fork SlicerAdapter (T_c8) against a materialized Grimoire profile
 * (T_c7). On success: writes the produced gcode to a persistent location,
 * inserts a `forge_artifacts` row with kind='gcode', and atomically transitions
 * the job to 'claimable'. On failure: maps the adapter failure reason to a
 * DispatchFailureReason and calls markFailed.
 *
 * Mirrors the V2-005b forge-converter-worker shape:
 *   - runOneSlicerTick     — one pass; intended for tests + the loop
 *   - startForgeSlicerWorker — long-running loop with abort + concurrency
 *   - stopForgeSlicerWorker  — module-level handle for graceful shutdown
 *
 * Concurrency: 1. Slicing is CPU-bound and minutes-scale; the throughput
 * benefit of running multiple slices in parallel on the same host is small,
 * and PrusaSlicer's resource usage spikes are aggressive enough to make
 * single-tracked execution the safer default. (Configurable via
 * WORKER_FORGE_SLICER_CONCURRENCY for completeness, clamped to [1, 4].)
 *
 * Resin-printer dispatches arriving in `slicing` are a contract violation — the
 * post-convert router should never route a resin job to slicing. We defensively
 * fail those with reason='unsupported-format'.
 *
 * SlicerProfile resolution — KNOWN LIMITATION (V2-005c-deferred):
 *   `dispatch_jobs` doesn't carry a slicer_profile_id column today. For T_c10
 *   MVP we pick the user's first slicer_profiles row (ownerId match, oldest
 *   first). Future work: surface profile selection in the dispatch UI + persist
 *   a slicer_profile_id on the job. Documented in apps/server/docs/operations/
 *   forge-tools.md.
 *
 * Failure-reason mapping (adapter → schema enum):
 *   'disabled-by-config' | 'not-installed' | 'binary-missing'
 *       → 'unsupported-format' (the host can't run a slicer right now;
 *         operator must install one before this job can succeed)
 *   'slicer-error' | 'no-output'
 *       → 'slicing-failed' (the slicer ran but produced an unusable result)
 *
 * The original adapter reason + details are always preserved verbatim in
 * dispatch_jobs.failure_details for ops post-mortems.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import { sleep } from '../scavengers/rate-limit';
import { markClaimable, markFailed } from '../forge/dispatch-state';
import {
  type DispatchFailureReason,
  type DispatchTargetKind,
  type ForgeSlicerKindInstallable,
} from '../db/schema.forge';
import { runCommand as defaultRunCommand } from '../forge/converter/run-command';
import type { RunCommand } from '../forge/converter/run-command';
import { createSlicerAdapter, type SliceResult } from '../forge/slicer/adapter';
import { getMaterializedConfigPath } from '../forge/slicer/profile-materialization';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Slicing is minutes-scale; poll slowly. */
const POLL_BASE_MS = 5_000;
const POLL_JITTER_MS = 1_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const DEFAULT_CONCURRENCY = 1;

/** Where the produced gcode is persisted. Mirrors profile-materialization's
 *  DATA_ROOT discipline: env override + sensible default. */
const DEFAULT_DATA_ROOT = '/data';
const ARTIFACTS_SUBDIR = 'forge-artifacts';

function getDataRoot(): string {
  const v = process.env.LOOTGOBLIN_DATA_ROOT;
  return v && v.length > 0 ? v : DEFAULT_DATA_ROOT;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let slicerAbort: AbortController | null = null;

export interface SlicerTickOpts {
  /** Override the production exec wrapper (forwarded to the adapter). */
  run?: RunCommand;
  /** DB URL override for tests with isolated SQLite files. */
  dbUrl?: string;
  /** For tests: pin "now". */
  now?: Date;
}

export interface SlicerTickCounts {
  jobsProcessed: number;
  jobsFailed: number;
  jobsSkipped: number;
}

// ---------------------------------------------------------------------------
// Internal types + helpers
// ---------------------------------------------------------------------------

interface SlicingCandidate {
  jobId: string;
  ownerId: string;
  lootId: string;
  targetKind: DispatchTargetKind;
  targetId: string;
  convertedFileId: string | null;
}

interface ResolvedInputFile {
  /** loot_files.id of the file we sliced. */
  id: string;
  /** Absolute on-disk path. */
  absolutePath: string;
}

/**
 * Map a printers.kind value to the slicer-fork we should invoke. Returns null
 * for resin printers (and anything else we can't slice via a Prusa fork).
 */
function mapPrinterKindToSlicerKind(
  printerKind: string,
): ForgeSlicerKindInstallable | null {
  switch (printerKind) {
    case 'fdm_klipper':
    case 'fdm_octoprint':
      return 'prusaslicer';
    case 'fdm_bambu_lan':
      return 'bambustudio';
    default:
      return null;
  }
}

type SliceFailure = Extract<SliceResult, { kind: 'failure' }>;

/** Map adapter failure reasons to the closed schema enum. See module header. */
function mapSliceFailure(failure: SliceFailure): {
  schemaReason: DispatchFailureReason;
  details: string;
} {
  switch (failure.reason) {
    case 'disabled-by-config':
    case 'not-installed':
    case 'binary-missing':
      return {
        schemaReason: 'unsupported-format',
        details: `${failure.reason}: ${failure.details ?? ''}`.trim(),
      };
    case 'slicer-error':
    case 'no-output':
      return {
        schemaReason: 'slicing-failed',
        details: `${failure.reason}: ${failure.details ?? ''}`.trim(),
      };
    default:
      return {
        schemaReason: 'unknown',
        details: `${(failure as { reason: string }).reason}: ${(failure as { details?: string }).details ?? ''}`.trim(),
      };
  }
}

/**
 * SELECT the oldest slicing dispatch job. No locking — the caller still has
 * to win the markClaimable / markFailed race, which is guarded by the atomic
 * UPDATE-with-WHERE-status pattern in dispatch-state.ts.
 *
 * Concurrency=1 means in practice one tick at a time will see a candidate;
 * the WHERE-status guard catches the odd race anyway.
 */
async function findSlicingCandidate(
  dbUrl?: string,
): Promise<SlicingCandidate | null> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({
      id: schema.dispatchJobs.id,
      ownerId: schema.dispatchJobs.ownerId,
      lootId: schema.dispatchJobs.lootId,
      targetKind: schema.dispatchJobs.targetKind,
      targetId: schema.dispatchJobs.targetId,
      convertedFileId: schema.dispatchJobs.convertedFileId,
    })
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.status, 'slicing'))
    .orderBy(asc(schema.dispatchJobs.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    jobId: row.id,
    ownerId: row.ownerId,
    lootId: row.lootId,
    targetKind: row.targetKind as DispatchTargetKind,
    targetId: row.targetId,
    convertedFileId: row.convertedFileId,
  };
}

/**
 * Resolve the input file for slicing:
 *   - if the job has convertedFileId, use that loot_files row;
 *   - otherwise fall back to the loot's primary file (oldest by createdAt).
 *
 * Returns null when no file is available — the worker fails the job.
 */
async function resolveInputFile(
  candidate: SlicingCandidate,
  dbUrl?: string,
): Promise<ResolvedInputFile | null> {
  const db = getServerDb(dbUrl);

  if (candidate.convertedFileId) {
    const rows = await db
      .select({
        id: schema.lootFiles.id,
        path: schema.lootFiles.path,
        rootPath: schema.stashRoots.path,
      })
      .from(schema.lootFiles)
      .innerJoin(schema.loot, eq(schema.lootFiles.lootId, schema.loot.id))
      .innerJoin(
        schema.collections,
        eq(schema.loot.collectionId, schema.collections.id),
      )
      .innerJoin(
        schema.stashRoots,
        eq(schema.collections.stashRootId, schema.stashRoots.id),
      )
      .where(eq(schema.lootFiles.id, candidate.convertedFileId))
      .limit(1);
    const row = rows[0];
    if (row) {
      const abs = path.isAbsolute(row.path)
        ? row.path
        : path.join(row.rootPath, row.path);
      return { id: row.id, absolutePath: abs };
    }
    // Fall through to primary-file lookup if the converted row vanished.
  }

  const rows = await db
    .select({
      id: schema.lootFiles.id,
      path: schema.lootFiles.path,
      rootPath: schema.stashRoots.path,
    })
    .from(schema.lootFiles)
    .innerJoin(schema.loot, eq(schema.lootFiles.lootId, schema.loot.id))
    .innerJoin(
      schema.collections,
      eq(schema.loot.collectionId, schema.collections.id),
    )
    .innerJoin(
      schema.stashRoots,
      eq(schema.collections.stashRootId, schema.stashRoots.id),
    )
    .where(eq(schema.lootFiles.lootId, candidate.lootId))
    .orderBy(asc(schema.lootFiles.createdAt), asc(schema.lootFiles.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const abs = path.isAbsolute(row.path)
    ? row.path
    : path.join(row.rootPath, row.path);
  return { id: row.id, absolutePath: abs };
}

/**
 * Look up the printers.kind for a printer-target dispatch job. Returns null
 * when the printer row is missing (delete race). Slicer-target jobs should
 * never reach the slicing worker — the post-convert router routes them to
 * 'claimable' — but if one does we treat it as unsupported.
 */
async function loadPrinterKind(
  candidate: SlicingCandidate,
  dbUrl?: string,
): Promise<string | null> {
  if (candidate.targetKind !== 'printer') return null;
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({ kind: schema.printers.kind })
    .from(schema.printers)
    .where(eq(schema.printers.id, candidate.targetId))
    .limit(1);
  return rows[0]?.kind ?? null;
}

/**
 * Pick the user's "first" slicer profile (oldest-by-createdAt). MVP for T_c10;
 * a future plan threads explicit profile selection through the dispatch route.
 */
async function pickFirstSlicerProfile(
  ownerId: string,
  dbUrl?: string,
): Promise<string | null> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({ id: schema.slicerProfiles.id })
    .from(schema.slicerProfiles)
    .where(eq(schema.slicerProfiles.ownerId, ownerId))
    .orderBy(asc(schema.slicerProfiles.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Persist the produced gcode to `<DATA_ROOT>/forge-artifacts/<jobId>/` and
 * insert the `forge_artifacts` row. Returns the persisted absolute path.
 */
async function persistGcodeArtifact(args: {
  jobId: string;
  gcodePath: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
  dbUrl?: string;
}): Promise<string> {
  const dir = path.join(getDataRoot(), ARTIFACTS_SUBDIR, args.jobId);
  await mkdir(dir, { recursive: true });
  const baseName = path.basename(args.gcodePath);
  const finalPath = path.join(dir, baseName);
  await copyFile(args.gcodePath, finalPath);

  const db = getServerDb(args.dbUrl);
  await db.insert(schema.forgeArtifacts).values({
    id: randomUUID(),
    dispatchJobId: args.jobId,
    kind: 'gcode',
    storagePath: finalPath,
    sizeBytes: args.sizeBytes,
    sha256: args.sha256,
    mimeType: 'text/x.gcode',
    metadataJson: JSON.stringify(args.metadata),
    createdAt: new Date(),
  });
  return finalPath;
}

// ---------------------------------------------------------------------------
// runOneSlicerTick
// ---------------------------------------------------------------------------

/**
 * One pass of the slicer worker. Returns a counts struct. `jobsSkipped` counts
 * disable-flag short-circuit hits + race-loss bails; `jobsProcessed` is the
 * count that completed (success OR mapped-failure terminal transition).
 */
export async function runOneSlicerTick(
  opts: SlicerTickOpts = {},
): Promise<SlicerTickCounts> {
  // 1. Honor disable flag — return immediately, don't even touch the DB.
  if (process.env.FORGE_DISABLE_SLICING === '1') {
    return { jobsProcessed: 0, jobsFailed: 0, jobsSkipped: 0 };
  }

  const candidate = await findSlicingCandidate(opts.dbUrl);
  if (!candidate) {
    return { jobsProcessed: 0, jobsFailed: 0, jobsSkipped: 0 };
  }

  const log = logger.child({
    jobId: candidate.jobId,
    targetKind: candidate.targetKind,
    targetId: candidate.targetId,
  });

  let outputDir: string | null = null;
  try {
    // 2. Resolve printer kind → slicer kind.
    if (candidate.targetKind !== 'printer') {
      log.warn('forge-slicer: slicing job on slicer-kind target — failing');
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'unsupported-format',
          details: 'slicing worker does not handle slicer-kind targets',
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return { jobsProcessed: 1, jobsFailed: 1, jobsSkipped: 0 };
    }
    const printerKind = await loadPrinterKind(candidate, opts.dbUrl);
    if (!printerKind) {
      log.warn('forge-slicer: target printer missing — failing');
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'unsupported-format',
          details: 'printer row not found',
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return { jobsProcessed: 1, jobsFailed: 1, jobsSkipped: 0 };
    }
    const slicerKind = mapPrinterKindToSlicerKind(printerKind);
    if (!slicerKind) {
      log.warn(
        { printerKind },
        'forge-slicer: printer kind has no slicer mapping (resin?) — failing',
      );
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'unsupported-format',
          details: `resin/other printers not supported by V2-005c slicers (kind=${printerKind})`,
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return { jobsProcessed: 1, jobsFailed: 1, jobsSkipped: 0 };
    }

    // 3. Resolve input file.
    const inputFile = await resolveInputFile(candidate, opts.dbUrl);
    if (!inputFile) {
      log.warn('forge-slicer: input file not resolvable — failing');
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'unsupported-format',
          details: 'no loot files available for slicing',
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return { jobsProcessed: 1, jobsFailed: 1, jobsSkipped: 0 };
    }

    // 4. Pick the user's first slicer profile (MVP).
    const profileId = await pickFirstSlicerProfile(
      candidate.ownerId,
      opts.dbUrl,
    );
    if (!profileId) {
      log.warn('forge-slicer: no slicer profile configured — failing');
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'unsupported-format',
          details: 'no slicer profile configured for owner',
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return { jobsProcessed: 1, jobsFailed: 1, jobsSkipped: 0 };
    }

    // 5. Materialize profile to disk.
    const configPath = await getMaterializedConfigPath({
      profileId,
      slicerKind,
      dbUrl: opts.dbUrl,
    });

    // 6. Per-job temp output dir.
    outputDir = await mkdtemp(
      path.join(tmpdir(), `forge-slicer-${candidate.jobId.slice(0, 8)}-`),
    );

    // 7. Build adapter + slice.
    const adapter = createSlicerAdapter({ slicerKind, dbUrl: opts.dbUrl });
    const result = await adapter.slice({
      inputPath: inputFile.absolutePath,
      outputDir,
      configPath,
      run: opts.run ?? defaultRunCommand,
    });

    if (result.kind === 'failure') {
      const { schemaReason, details } = mapSliceFailure(result);
      log.warn(
        { reason: result.reason, details: result.details, schemaReason },
        'forge-slicer: slice failed',
      );
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: schemaReason,
          details,
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return { jobsProcessed: 1, jobsFailed: 1, jobsSkipped: 0 };
    }

    // 8. Persist artifact + transition to claimable.
    const persistedPath = await persistGcodeArtifact({
      jobId: candidate.jobId,
      gcodePath: result.gcodePath,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      metadata: {
        slicerKind,
        slicerProfileId: profileId,
        printerKind,
        ...result.metadata,
      },
      dbUrl: opts.dbUrl,
    });

    const transition = await markClaimable(
      { jobId: candidate.jobId, from: 'slicing' },
      { dbUrl: opts.dbUrl },
    );
    if (!transition.ok) {
      log.error(
        { reason: transition.reason },
        'forge-slicer: markClaimable failed after successful slice',
      );
      // Defensive: the artifact row already exists and points at on-disk
      // bytes; leaving the job in slicing isn't ideal, but the next tick
      // (or operator) can resolve it. Don't try to delete the artifact —
      // the on-disk gcode may be useful diagnostic output.
      return { jobsProcessed: 0, jobsFailed: 0, jobsSkipped: 1 };
    }
    log.info(
      {
        slicerKind,
        printerKind,
        profileId,
        persistedPath,
        sizeBytes: result.sizeBytes,
      },
      'forge-slicer: → claimable',
    );
    return { jobsProcessed: 1, jobsFailed: 0, jobsSkipped: 0 };
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'forge-slicer: tick threw');
    const fail = await markFailed(
      {
        jobId: candidate.jobId,
        reason: 'unknown',
        details,
      },
      { dbUrl: opts.dbUrl, now: opts.now },
    );
    if (!fail.ok) {
      log.warn(
        { reason: fail.reason },
        'forge-slicer: markFailed (post-throw) returned not-ok',
      );
    }
    return { jobsProcessed: 1, jobsFailed: 1, jobsSkipped: 0 };
  } finally {
    if (outputDir) {
      try {
        await rm(outputDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        logger.warn(
          {
            outputDir,
            err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          },
          'forge-slicer: failed to clean up temp output dir',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

/**
 * Start the forge slicer worker. Returns a stop function. Idempotent — second
 * call without first stopping returns a no-op stop. Use `stopForgeSlicerWorker`
 * for the module-level shutdown path (instrumentation.ts).
 */
export function startForgeSlicerWorker(
  opts: {
    intervalMs?: number;
    run?: RunCommand;
    dbUrl?: string;
    concurrency?: number;
  } = {},
): () => void {
  if (slicerAbort) {
    // Already running.
    return () => stopForgeSlicerWorker();
  }
  slicerAbort = new AbortController();
  const signal = slicerAbort.signal;

  const concurrency = clampConcurrency(
    opts.concurrency ??
      Number(process.env.WORKER_FORGE_SLICER_CONCURRENCY ?? DEFAULT_CONCURRENCY),
  );

  logger.info({ concurrency }, 'forge-slicer: started');

  const intervalMs = opts.intervalMs ?? POLL_BASE_MS;

  const loops: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i += 1) {
    loops.push(
      runSlicerLoop({
        signal,
        run: opts.run,
        dbUrl: opts.dbUrl,
        baseMs: intervalMs,
      }),
    );
  }
  // Detach: the caller doesn't await the loops.
  void Promise.all(loops).catch((err) =>
    logger.error({ err }, 'forge-slicer: loop crashed'),
  );

  return () => stopForgeSlicerWorker();
}

export function stopForgeSlicerWorker(): void {
  slicerAbort?.abort();
  slicerAbort = null;
}

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 4) return 4;
  return Math.floor(n);
}

async function runSlicerLoop(args: {
  signal: AbortSignal;
  run?: RunCommand;
  dbUrl?: string;
  baseMs: number;
}): Promise<void> {
  let backoffMs = 0;

  while (!args.signal.aborted) {
    let counts: SlicerTickCounts;
    let errored = false;
    try {
      counts = await runOneSlicerTick({
        run: args.run,
        dbUrl: args.dbUrl,
      });
    } catch (err) {
      logger.error({ err }, 'forge-slicer: tick threw — backing off');
      counts = { jobsProcessed: 0, jobsFailed: 0, jobsSkipped: 0 };
      errored = true;
    }

    if (errored) {
      backoffMs =
        backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    } else if (counts.jobsProcessed > 0) {
      backoffMs = 0;
    }
    // idle (all zero) leaves backoff at 0 — short polite poll.

    const jitter =
      Math.floor(Math.random() * (POLL_JITTER_MS * 2)) - POLL_JITTER_MS;
    const waitMs = backoffMs > 0 ? backoffMs : Math.max(500, args.baseMs + jitter);

    try {
      await sleep(waitMs, args.signal);
    } catch {
      // signal aborted during sleep — top-of-loop will exit.
    }
  }
}

