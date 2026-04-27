/**
 * Forge converter worker — V2-005b-T_b4.
 *
 * Drains `dispatch_jobs WHERE status = 'pending'` and runs the V2-005b
 * format converter (T_b1 framework + T_b3 Blender backend + T_b1 sharp/7z
 * backends). Each tick:
 *
 *   1. SELECT the oldest 'pending' dispatch job.
 *
 *   2. Atomic transition pending → converting (markConverting). Race losers
 *      bail out (return 'idle').
 *
 *   3. Look up the loot's primary file via detectLootPrimaryFormat (T6) +
 *      a directly-read lootFiles row to get its on-disk path.
 *
 *   4. Look up the target's kind (printer.kind or forge_slicer.kind) via the
 *      poly-FK pattern, then ask getCompatibility(format, kind).
 *
 *      - 'native'              → markClaimable(from='converting'). The matrix
 *        already gates initial-status at create time so this branch is
 *        defensive — pending should not be set on native pairs by the route.
 *      - 'unsupported'         → markFailed reason='unsupported-format'.
 *        Same defensive note: route 422s these before insert.
 *      - 'conversion-required' → run the converter.
 *
 *   5. converter call: convertFile({ inputPath, inputFormat, outputFormat }).
 *      For archive sources, outputFormat is 'archive-extract' (matrix sentinel
 *      from V2-005a-T6).
 *
 *   6. On converter success:
 *        - Multi-output (archive extract): pick the FIRST extracted file
 *          whose extension is native/convertable for the target. If none is
 *          usable → markFailed reason='unsupported-format' details='archive
 *          contained no convertable file'.
 *        - Single output: use it directly.
 *      Insert a new loot_files row (origin='ingest' marker for derivative;
 *      see schema note below) referencing the same lootId. Update
 *      dispatch_jobs.convertedFileId. markClaimable(from='converting').
 *
 *   7. On converter failure: map ConversionFailureReason to
 *      DispatchFailureReason and markFailed. Reason mapping:
 *        - missing-tool / not-implemented / disabled-by-config / tool-failed
 *            → 'conversion-failed'
 *        - unsupported-pair                        → 'unsupported-format'
 *        - invalid-input                            → 'conversion-failed'
 *        - archive-no-usable-content                → 'unsupported-format'
 *
 * Polling cadence:
 *   - 2s base + ±500ms jitter on idle/ran (slower than the claim worker because
 *     conversions are CPU-bound and don't benefit from rapid polling).
 *   - exponential backoff 5s → 60s on errors.
 *
 * Concurrency: 1 by default. Conversions are CPU-bound; multiple parallel
 * Blender invocations on the same host typically don't add throughput.
 * Configurable via WORKER_FORGE_CONVERTER_CONCURRENCY.
 *
 * No bootstrap dependency — unlike the claim worker, the converter worker
 * doesn't need a central_worker agent row; it works with whatever is in the
 * 'pending' queue.
 *
 * Schema note on derivative loot_files:
 *   The existing loot_files schema has no `kind` / `derivative_of` column.
 *   We store the converted file with `origin='ingest'` (the closest existing
 *   value — its provenance is "ingested by the converter worker"), with
 *   `provenance.kind = 'forge-conversion'` + `provenance.sourceLootFileId`
 *   so downstream code can recognise the derivative if needed. This mirrors
 *   the pattern V2-002 uses for thumbnail files (also derivative; also
 *   stamped via the provenance JSON).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, stat as fsStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import { sleep } from '../scavengers/rate-limit';
import { sha256Hex } from '../stash/hash-util';
import {
  markClaimable,
  markConverting,
  markFailed,
} from '../forge/dispatch-state';
import {
  type DispatchFailureReason,
  type DispatchTargetKind,
} from '../db/schema.forge';
import {
  convertFile,
  type ConversionResult,
  type ConversionFailureReason,
  type RunCommand,
} from '../forge/converter';
import {
  ARCHIVE_EXTRACT_SENTINEL,
  getCompatibility,
  type CompatibilityVerdict,
  type TargetKind,
} from '../forge/target-compatibility';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const POLL_BASE_MS = 2000;
const POLL_JITTER_MS = 500;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
/** Per-conversion timeout (matches T_b3 Blender default). */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CONCURRENCY = 1;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let converterAbort: AbortController | null = null;

export interface ConverterTickOpts {
  /** Override the production exec wrapper (forwarded to convertFile). */
  runCommand?: RunCommand;
  now?: Date;
  /** Per-call timeout — bounds the entire convertFile call. Default 5 min. */
  timeoutMs?: number;
  /** DB URL override for tests with isolated SQLite files. */
  dbUrl?: string;
}

// ---------------------------------------------------------------------------
// Internal types + helpers
// ---------------------------------------------------------------------------

interface PendingCandidate {
  jobId: string;
  ownerId: string;
  lootId: string;
  targetKind: DispatchTargetKind;
  targetId: string;
}

interface PrimaryFile {
  /** loot_files.id of the source file. */
  id: string;
  /** loot_files.path (relative to stashRoot.path). */
  path: string;
  /** Absolute on-disk path (stashRoot.path + path). */
  absolutePath: string;
  format: string;
}

/** Lower-case + strip leading dot. Mirrors target-compatibility's normalizer. */
function normalizeFormat(format: string): string {
  return format.replace(/^\./, '').toLowerCase();
}

/** Pull the extension off a filename, lowercased + dot-stripped. */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return normalizeFormat(name.slice(dot + 1));
}

/**
 * SELECT the oldest pending dispatch job. No reachability filter — pending
 * isn't claim-time, the converter worker simply drives the conversion.
 *
 * Returns null when no candidate exists. Caller still has to win the race
 * via markConverting (the SELECT is unguarded — concurrent ticks may pick
 * the same row, and the WHERE on markConverting serialises them).
 */
async function findPendingCandidate(dbUrl?: string): Promise<PendingCandidate | null> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({
      id: schema.dispatchJobs.id,
      ownerId: schema.dispatchJobs.ownerId,
      lootId: schema.dispatchJobs.lootId,
      targetKind: schema.dispatchJobs.targetKind,
      targetId: schema.dispatchJobs.targetId,
    })
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.status, 'pending'))
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
  };
}

/**
 * Resolve the loot's primary file. Ordered by (createdAt asc, id asc) to
 * match detectLootPrimaryFormat's discipline. Returns null when no files
 * exist OR when the file's stash root cannot be resolved.
 */
async function loadPrimaryLootFile(
  lootId: string,
  dbUrl?: string,
): Promise<PrimaryFile | null> {
  const db = getServerDb(dbUrl);
  // Inner-join through loot → collections → stash_roots so we get the
  // absolute on-disk path for the file. lootFiles.path is relative to the
  // root (per V2-002 schema notes).
  const rows = await db
    .select({
      id: schema.lootFiles.id,
      path: schema.lootFiles.path,
      format: schema.lootFiles.format,
      rootPath: schema.stashRoots.path,
    })
    .from(schema.lootFiles)
    .innerJoin(schema.loot, eq(schema.lootFiles.lootId, schema.loot.id))
    .innerJoin(schema.collections, eq(schema.loot.collectionId, schema.collections.id))
    .innerJoin(schema.stashRoots, eq(schema.collections.stashRootId, schema.stashRoots.id))
    .where(eq(schema.lootFiles.lootId, lootId))
    .orderBy(asc(schema.lootFiles.createdAt), asc(schema.lootFiles.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const rel = row.path;
  const absolutePath = path.isAbsolute(rel) ? rel : path.join(row.rootPath, rel);
  const format = row.format ? normalizeFormat(row.format) : extOf(row.path);
  return {
    id: row.id,
    path: row.path,
    absolutePath,
    format,
  };
}

/**
 * Look up the target row's kind string. For 'printer' → printers.kind; for
 * 'slicer' → forge_slicers.kind. Returns null if the row is gone (race with
 * a delete; the caller will markFailed).
 */
async function loadTargetKind(
  targetKind: DispatchTargetKind,
  targetId: string,
  dbUrl?: string,
): Promise<string | null> {
  const db = getServerDb(dbUrl);
  if (targetKind === 'printer') {
    const rows = await db
      .select({ kind: schema.printers.kind })
      .from(schema.printers)
      .where(eq(schema.printers.id, targetId))
      .limit(1);
    return rows[0]?.kind ?? null;
  }
  const rows = await db
    .select({ kind: schema.forgeSlicers.kind })
    .from(schema.forgeSlicers)
    .where(eq(schema.forgeSlicers.id, targetId))
    .limit(1);
  return rows[0]?.kind ?? null;
}

/**
 * Map a ConversionFailureReason from the converter framework onto a
 * DispatchFailureReason on the dispatch_jobs row. Most converter failures
 * collapse to 'conversion-failed'; only the "this format isn't accepted by
 * the target at all" cases become 'unsupported-format'.
 */
function mapFailureReason(reason: ConversionFailureReason): DispatchFailureReason {
  switch (reason) {
    case 'unsupported-pair':
    case 'archive-no-usable-content':
      return 'unsupported-format';
    case 'missing-tool':
    case 'not-implemented':
    case 'disabled-by-config':
    case 'tool-failed':
    case 'invalid-input':
    default:
      return 'conversion-failed';
  }
}

/**
 * Pick the first usable file from a multi-output (archive extract). A file
 * is "usable" if its extension is native to the target OR has a known
 * conversion path to a native format (matrix verdict band !== 'unsupported').
 */
function pickUsableFromArchive(
  outputs: ReadonlyArray<string>,
  targetKindStr: TargetKind,
): string | undefined {
  for (const candidate of outputs) {
    const ext = extOf(path.basename(candidate));
    if (!ext) continue;
    const verdict = getCompatibility(ext, targetKindStr);
    if (verdict.band !== 'unsupported') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Insert a derivative loot_files row pointing at the converted file on
 * disk. We do not move the file into the stash root — converted artifacts
 * live in a temp directory the worker manages. The path stored is absolute
 * (lootFiles.path tolerates both relative + absolute forms; readers handle
 * both).
 */
async function insertDerivativeLootFile(args: {
  lootId: string;
  sourceLootFileId: string;
  absoluteOutputPath: string;
  outputFormat: string;
  dbUrl?: string;
}): Promise<string> {
  const db = getServerDb(args.dbUrl);
  const id = randomUUID();
  const [hash, sizeBytes] = await Promise.all([
    sha256Hex(args.absoluteOutputPath),
    fsStat(args.absoluteOutputPath).then((s) => s.size),
  ]);
  await db.insert(schema.lootFiles).values({
    id,
    lootId: args.lootId,
    path: args.absoluteOutputPath,
    format: normalizeFormat(args.outputFormat),
    size: sizeBytes,
    hash,
    origin: 'ingest',
    provenance: {
      kind: 'forge-conversion',
      sourceLootFileId: args.sourceLootFileId,
    },
    createdAt: new Date(),
  });
  return id;
}

/** UPDATE dispatch_jobs.convertedFileId for the given job. */
async function setConvertedFileId(
  jobId: string,
  fileId: string,
  dbUrl?: string,
): Promise<void> {
  const db = getServerDb(dbUrl);
  await db
    .update(schema.dispatchJobs)
    .set({ convertedFileId: fileId })
    .where(eq(schema.dispatchJobs.id, jobId));
}

/**
 * Create a fresh per-job temp dir for the converter to drop outputs into.
 * The caller never deletes — long-term, an idle-cleaner can sweep the
 * tmpdir; v2 ships without it (see V2-005b plan).
 */
async function makeJobOutputDir(jobId: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `forge-conv-${jobId.slice(0, 8)}-`));
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// runOneConverterTick
// ---------------------------------------------------------------------------

/**
 * One pass of the converter loop. Returns:
 *   'ran'     — picked a job and reached a terminal pending→{claimable|failed}
 *               transition for it.
 *   'idle'    — no pending job (or race lost on markConverting).
 *   'errored' — exception thrown during conversion (job ends in 'failed').
 */
export async function runOneConverterTick(
  opts: ConverterTickOpts = {},
): Promise<'ran' | 'idle' | 'errored'> {
  const candidate = await findPendingCandidate(opts.dbUrl);
  if (!candidate) return 'idle';

  // Atomic transition pending → converting. Race losers bail out.
  const startResult = await markConverting(
    { jobId: candidate.jobId },
    { dbUrl: opts.dbUrl },
  );
  if (!startResult.ok) {
    // Another tick won the race OR the row moved out of pending.
    return 'idle';
  }

  const log = logger.child({
    jobId: candidate.jobId,
    targetKind: candidate.targetKind,
    targetId: candidate.targetId,
  });

  try {
    // Look up the loot's primary file.
    const primary = await loadPrimaryLootFile(candidate.lootId, opts.dbUrl);
    if (!primary) {
      log.warn('forge-converter: loot has no files; failing job');
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'unsupported-format',
          details: 'Loot has no files',
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return 'errored';
    }
    if (!primary.format) {
      log.warn('forge-converter: primary file has no recognisable format');
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'unsupported-format',
          details: 'Primary file has no recognisable extension',
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return 'errored';
    }

    // Look up the target's kind.
    const targetKindStr = await loadTargetKind(
      candidate.targetKind,
      candidate.targetId,
      opts.dbUrl,
    );
    if (!targetKindStr) {
      log.warn('forge-converter: target row missing; failing job');
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'unsupported-format',
          details: 'Dispatch target row not found',
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return 'errored';
    }

    // The target's kind string MUST be one of the matrix's TargetKind union;
    // anything else is a contract violation upstream. Cast + defensively
    // validate via getCompatibility itself returning band='unsupported'.
    const verdict: CompatibilityVerdict = getCompatibility(
      primary.format,
      targetKindStr as TargetKind,
    );

    if (verdict.band === 'native') {
      // Defensive — route should set initial-status='claimable' for native
      // pairs. If we got here, it's a route bug, but the right move is just
      // to flip the row to claimable so dispatch can proceed.
      log.warn(
        { format: primary.format, targetKind: targetKindStr },
        'forge-converter: pending row had a native verdict (route bug?); flipping to claimable',
      );
      await markClaimable(
        { jobId: candidate.jobId, from: 'converting' },
        { dbUrl: opts.dbUrl },
      );
      return 'ran';
    }

    if (verdict.band === 'unsupported') {
      log.warn(
        { format: primary.format, targetKind: targetKindStr, reason: verdict.reason },
        'forge-converter: matrix returned unsupported on a pending row; failing',
      );
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'unsupported-format',
          details: verdict.reason ?? 'Target does not accept this format',
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return 'errored';
    }

    // band === 'conversion-required' from here on.
    const outputFormat = verdict.conversionTo;
    if (!outputFormat) {
      // Matrix invariant: conversion-required ALWAYS supplies conversionTo.
      // Defensive only.
      log.error(
        { format: primary.format, targetKind: targetKindStr },
        'forge-converter: matrix returned conversion-required without conversionTo',
      );
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: 'conversion-failed',
          details: 'matrix returned conversion-required without conversionTo',
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return 'errored';
    }

    // ------------------------------------------------------------------
    // Run the converter.
    // ------------------------------------------------------------------

    const outputDir = await makeJobOutputDir(candidate.jobId);

    const conversionPromise = convertFile(
      {
        inputPath: primary.absolutePath,
        inputFormat: primary.format,
        outputFormat,
        outputDir,
      },
      { runCommand: opts.runCommand },
    );

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = new Promise<ConversionResult>((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: false,
            reason: 'tool-failed',
            details: `Converter exceeded ${timeoutMs}ms timeout`,
          }),
        timeoutMs,
      ),
    );

    const result = await Promise.race([conversionPromise, timer]);

    if (!result.ok) {
      const dispatchReason = mapFailureReason(result.reason);
      log.warn(
        { reason: result.reason, details: result.details },
        'forge-converter: conversion failed',
      );
      await markFailed(
        {
          jobId: candidate.jobId,
          reason: dispatchReason,
          details: result.details ?? `converter reported ${result.reason}`,
        },
        { dbUrl: opts.dbUrl, now: opts.now },
      );
      return 'errored';
    }

    // ------------------------------------------------------------------
    // Pick the output file. Single-file (image/mesh) → outputPaths[0].
    // Multi-file (archive extract) → first usable per the matrix.
    // ------------------------------------------------------------------

    let chosenPath: string | undefined;
    let chosenFormat: string;
    if (outputFormat === ARCHIVE_EXTRACT_SENTINEL) {
      chosenPath = pickUsableFromArchive(
        result.outputPaths,
        targetKindStr as TargetKind,
      );
      if (!chosenPath) {
        log.warn(
          { extracted: result.outputPaths.length },
          'forge-converter: archive extract had no target-compatible files',
        );
        await markFailed(
          {
            jobId: candidate.jobId,
            reason: 'unsupported-format',
            details: 'Archive contained no file the target can accept',
          },
          { dbUrl: opts.dbUrl, now: opts.now },
        );
        return 'errored';
      }
      chosenFormat = extOf(path.basename(chosenPath));
    } else {
      chosenPath = result.outputPaths[0];
      if (!chosenPath) {
        log.error('forge-converter: converter returned ok=true with no outputPaths');
        await markFailed(
          {
            jobId: candidate.jobId,
            reason: 'conversion-failed',
            details: 'Converter returned ok=true but produced no output',
          },
          { dbUrl: opts.dbUrl, now: opts.now },
        );
        return 'errored';
      }
      chosenFormat = outputFormat;
    }

    // ------------------------------------------------------------------
    // Insert derivative loot_files row + wire convertedFileId.
    // ------------------------------------------------------------------

    const newFileId = await insertDerivativeLootFile({
      lootId: candidate.lootId,
      sourceLootFileId: primary.id,
      absoluteOutputPath: chosenPath,
      outputFormat: chosenFormat,
      dbUrl: opts.dbUrl,
    });
    await setConvertedFileId(candidate.jobId, newFileId, opts.dbUrl);

    // converting → claimable.
    const claimableResult = await markClaimable(
      { jobId: candidate.jobId, from: 'converting' },
      { dbUrl: opts.dbUrl },
    );
    if (!claimableResult.ok) {
      // Should not happen — we own the row. Surface it loudly so any race
      // bug becomes visible in logs.
      log.error(
        { reason: claimableResult.reason },
        'forge-converter: markClaimable failed after successful conversion',
      );
      return 'errored';
    }

    log.info(
      { convertedFileId: newFileId, outputFormat: chosenFormat },
      'forge-converter: pending → claimable',
    );
    return 'ran';
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'forge-converter: tick threw');
    const failResult = await markFailed(
      {
        jobId: candidate.jobId,
        reason: 'unknown',
        details,
      },
      { dbUrl: opts.dbUrl, now: opts.now },
    );
    if (!failResult.ok) {
      log.warn(
        { reason: failResult.reason },
        'forge-converter: markFailed (post-throw) returned not-ok',
      );
    }
    return 'errored';
  }
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

/**
 * Start the forge converter worker pool. Idempotent — second call is a no-op
 * while the first is still running. Resolves when the pool exits (after
 * the AbortSignal fires + every loop drains its current sleep).
 */
export async function startForgeConverterWorker(
  opts: {
    signal?: AbortSignal;
    concurrency?: number;
    runCommand?: RunCommand;
    dbUrl?: string;
  } = {},
): Promise<void> {
  if (converterAbort && !opts.signal) return;
  if (!opts.signal) {
    converterAbort = new AbortController();
  }
  const signal = opts.signal ?? converterAbort!.signal;

  const concurrency = clampConcurrency(
    opts.concurrency ??
      Number(process.env.WORKER_FORGE_CONVERTER_CONCURRENCY ?? DEFAULT_CONCURRENCY),
  );

  logger.info({ concurrency }, 'forge-converter: started');

  const loops = Array.from({ length: concurrency }, () =>
    runConverterLoop({
      signal,
      runCommand: opts.runCommand,
      dbUrl: opts.dbUrl,
    }),
  );
  await Promise.all(loops);
}

export function stopForgeConverterWorker(): void {
  converterAbort?.abort();
  converterAbort = null;
}

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 8) return 8;
  return Math.floor(n);
}

async function runConverterLoop(args: {
  signal: AbortSignal;
  runCommand?: RunCommand;
  dbUrl?: string;
}): Promise<void> {
  let backoffMs = 0;

  while (!args.signal.aborted) {
    let result: 'ran' | 'idle' | 'errored';
    try {
      result = await runOneConverterTick({
        runCommand: args.runCommand,
        dbUrl: args.dbUrl,
      });
    } catch (err) {
      logger.error({ err }, 'forge-converter: tick threw — backing off');
      result = 'errored';
    }

    if (result === 'errored') {
      backoffMs =
        backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    } else if (result === 'ran') {
      backoffMs = 0;
    }
    // 'idle' leaves backoff at 0 — short polite poll.

    const jitter = Math.floor(Math.random() * (POLL_JITTER_MS * 2)) - POLL_JITTER_MS;
    const waitMs = backoffMs > 0 ? backoffMs : Math.max(100, POLL_BASE_MS + jitter);

    try {
      await sleep(waitMs, args.signal);
    } catch {
      // Signal aborted mid-sleep — loop condition will exit on the next pass.
    }
  }
}
