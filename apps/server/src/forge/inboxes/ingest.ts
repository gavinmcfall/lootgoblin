/**
 * V2-005e-T_e2: Forge inbox watcher manager.
 *
 * One chokidar watcher per active forge_inboxes row. Filesystem add events
 * are classified — slicer-output files are handed off to handleSliceArrival,
 * non-slicer files are ignored (the Forge inbox is intentionally
 * single-purpose for slice files; users keep general-purpose inboxes via
 * V2-002-T8 Stash inbox triage).
 *
 * T_e2 keeps `handleSliceArrival` as a STUB that classifies + logs. T_e3
 * replaces it with the three-tier source-Loot association (sidecar, heuristic,
 * pending-pairing queue) and the actual ingest hand-off. The classifier
 * decision (`slicerOutput.value === true`) is the seam T_e3 builds on.
 *
 * Manager state lives in this module's `watchers` map (process-singleton —
 * one server instance, one watcher per inbox). Boot recovery runs from
 * instrumentation.ts; routes call start/stop on PATCH/DELETE/POST.
 */

import * as path from 'node:path';
import * as fsp from 'node:fs/promises';

import { logger } from '../../logger';
import {
  createFileWatcher,
  type FileWatcher,
} from '../../stash/file-watcher';
import {
  createClassifier,
  type Classifier,
  type ClassificationResult,
} from '../../stash/classifier';
import {
  createSlicerOutputProvider,
  createFilenameProvider,
} from '../../stash/classifier-providers';
import { listActiveInboxes } from './lifecycle';
import type { ForgeInboxRow } from './types';

interface ActiveWatcher {
  inboxId: string;
  path: string;
  watcher: FileWatcher;
}

const watchers = new Map<string, ActiveWatcher>();

/**
 * Default classifier for the Forge inbox. A narrow subset of the V2-002
 * provider set: slicer-output (the discriminator we actually need) +
 * filename (for downstream T_e3 sibling-name heuristics). Source-3MF /
 * datapackage / EXIF are deliberately excluded — slice files don't carry
 * authorship metadata, and parsing every arrival would burn CPU for nothing.
 *
 * Test seams (lifecycle.start) inject a custom classifier via opts.
 */
function defaultSliceClassifier(): Classifier {
  return createClassifier({
    providers: [createSlicerOutputProvider(), createFilenameProvider()],
    // Slicer-output detection is binary; required-fields checking would
    // spuriously flag every slice as needing user input. The watcher reads
    // `result.slicerOutput?.value` directly.
    requiredFields: [],
  });
}

let cachedClassifier: Classifier | null = null;
function getClassifier(): Classifier {
  if (!cachedClassifier) {
    cachedClassifier = defaultSliceClassifier();
  }
  return cachedClassifier;
}

// ---------------------------------------------------------------------------
// Slice-arrival handler — STUB for T_e2; T_e3 replaces with three-tier match.
// ---------------------------------------------------------------------------

export interface SliceArrivalArgs {
  inbox: ForgeInboxRow;
  filePath: string;
  /** Injected for testing. Defaults to the module-cached classifier. */
  classifier?: Classifier;
}

export interface SliceArrivalOutcome {
  classified: boolean;
  isSlicerOutput: boolean;
  classification?: ClassificationResult;
  /**
   * If false, the file was rejected before classification (e.g. lstat
   * failed, file is a symlink, file vanished). The watcher logs the
   * reason; T_e3 + future tests assert on `processed === true`.
   */
  processed: boolean;
}

/**
 * Process a single file arriving on a watched inbox.
 *
 * T_e2 contract:
 *   1. lstat — skip symlinks, skip non-files.
 *   2. Classify with the slicer-output provider.
 *   3. If `slicerOutput.value === true`, log + return outcome (stub
 *      hand-off seam for T_e3).
 *   4. Otherwise, log + ignore (the Forge inbox is for slice files).
 *
 * NO ingest_jobs row is inserted, NO loot row is created — T_e3 does that
 * via a hand-off into the V2-002 adoption applier (the file-on-disk
 * counterpart to V2-003's URL/adapter pipeline).
 *
 * Exported so tests can drive it without standing up a real chokidar
 * watcher; the watcher's onAdd callback delegates here.
 */
export async function handleSliceArrival(
  args: SliceArrivalArgs,
): Promise<SliceArrivalOutcome> {
  const { inbox, filePath } = args;
  const classifier = args.classifier ?? getClassifier();

  let lstatResult: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    lstatResult = await fsp.lstat(filePath);
  } catch (err) {
    logger.warn({ err, inboxId: inbox.id, filePath }, 'forge-inbox: lstat failed');
    return { classified: false, isSlicerOutput: false, processed: false };
  }
  if (lstatResult.isSymbolicLink() || !lstatResult.isFile()) {
    logger.debug(
      { inboxId: inbox.id, filePath },
      'forge-inbox: skipping symlink or non-file',
    );
    return { classified: false, isSlicerOutput: false, processed: false };
  }

  const basename = path.basename(filePath);

  let classification: ClassificationResult;
  try {
    classification = await classifier.classify({
      files: [
        {
          absolutePath: filePath,
          relativePath: basename,
          size: lstatResult.size,
          mtime: lstatResult.mtime,
        },
      ],
      folderRelativePath: '',
    });
  } catch (err) {
    logger.warn(
      { err, inboxId: inbox.id, filePath },
      'forge-inbox: classifier threw',
    );
    return { classified: false, isSlicerOutput: false, processed: true };
  }

  const isSlicerOutput = classification.slicerOutput?.value === true;
  if (!isSlicerOutput) {
    logger.debug(
      { inboxId: inbox.id, filePath, primaryFormat: classification.primaryFormat?.value },
      'forge-inbox: arrival not classified as slicer-output, ignoring',
    );
    return { classified: true, isSlicerOutput: false, classification, processed: true };
  }

  // T_e2 hand-off seam — log only. T_e3 replaces this body with the
  // three-tier source-Loot association + applier hand-off + optional
  // dispatch_jobs auto-enqueue against `inbox.defaultPrinterId`.
  logger.info(
    {
      inboxId: inbox.id,
      ownerId: inbox.ownerId,
      filePath,
      primaryFormat: classification.primaryFormat?.value,
      defaultPrinterId: inbox.defaultPrinterId,
    },
    'forge-inbox: slicer-output detected (T_e3 will perform source-Loot match + ingest)',
  );

  return { classified: true, isSlicerOutput: true, classification, processed: true };
}

// ---------------------------------------------------------------------------
// Watcher lifecycle
// ---------------------------------------------------------------------------

export interface StartInboxWatcherOptions {
  /**
   * Override the file-watcher factory for tests that need to drive events
   * synchronously. Defaults to the real chokidar wrapper.
   */
  createWatcher?: typeof createFileWatcher;
  /**
   * Override the slice-arrival handler. Tests use this to assert the
   * watcher wiring without relying on the real classifier.
   */
  onSliceArrival?: (args: SliceArrivalArgs) => Promise<SliceArrivalOutcome>;
  /**
   * Stability threshold in ms (chokidar awaitWriteFinish). Defaults to
   * 2000 (matches V2-002-T4 default).
   */
  stabilityThresholdMs?: number;
}

/**
 * Start a chokidar watcher for the given inbox. Idempotent — calling twice
 * for the same inbox.id is a no-op (returns immediately, no second watcher
 * is created).
 *
 * Returns a Promise that resolves when chokidar's initial scan completes
 * (`watcher.ready()`). On startup error (e.g. directory does not exist),
 * the error is logged + the entry is removed from the manager map; the
 * function does NOT throw, so route handlers don't have to wrap every
 * create/update call in try/catch. The on-disk path being missing is a
 * known failure mode (the user pointed us at a path that doesn't exist
 * yet) — the watcher entry is dropped + a warn log surfaces it for the
 * UI to nag the user about.
 */
export async function startInboxWatcher(
  inbox: ForgeInboxRow,
  options: StartInboxWatcherOptions = {},
): Promise<void> {
  if (watchers.has(inbox.id)) {
    return;
  }

  const factory = options.createWatcher ?? createFileWatcher;
  const handler = options.onSliceArrival ?? handleSliceArrival;
  const stabilityThresholdMs = options.stabilityThresholdMs ?? 2000;

  const fw = factory({
    paths: [inbox.path],
    // Slice files arriving in the inbox after server start fire add events;
    // pre-existing files are ignored to avoid replaying every prior slice
    // on every server restart. T_e3 may add a sweep flag for explicit
    // backfill if needed.
    emitInitialAdds: false,
    stabilityThresholdMs,
  });

  fw.onEvent((event) => {
    if (event.kind !== 'add' && event.kind !== 'change') return;
    void handler({ inbox, filePath: event.path }).catch((err) => {
      logger.error(
        { err, inboxId: inbox.id, filePath: event.path },
        'forge-inbox: slice-arrival handler threw',
      );
    });
  });

  // Insert into the map BEFORE awaiting start() so a concurrent
  // startInboxWatcher call hits the idempotency guard above instead of
  // racing to create a second watcher.
  watchers.set(inbox.id, { inboxId: inbox.id, path: inbox.path, watcher: fw });

  try {
    await fw.start();
    logger.info(
      { inboxId: inbox.id, path: inbox.path },
      'forge-inbox: watcher started',
    );
  } catch (err) {
    // Pre-ready chokidar error (most often: ENOENT on inbox.path). Log +
    // drop the entry so the next start attempt (e.g. user fixes the path
    // via PATCH) succeeds.
    watchers.delete(inbox.id);
    logger.warn(
      { err, inboxId: inbox.id, path: inbox.path },
      'forge-inbox: watcher failed to start (path may not exist)',
    );
  }
}

/**
 * Stop the watcher for the given inbox. Idempotent — no-op if no watcher
 * is currently active.
 */
export async function stopInboxWatcher(inboxId: string): Promise<void> {
  const entry = watchers.get(inboxId);
  if (!entry) return;
  watchers.delete(inboxId);
  try {
    await entry.watcher.stop();
    logger.info({ inboxId }, 'forge-inbox: watcher stopped');
  } catch (err) {
    logger.warn({ err, inboxId }, 'forge-inbox: watcher stop threw');
  }
}

/**
 * Boot recovery — re-attach a watcher per active forge_inboxes row. Called
 * from instrumentation.ts after migrations + central-worker bootstrap.
 *
 * Failure semantics:
 *   - Per-inbox start errors are caught + logged; recovery continues with
 *     the next row.
 *   - The function never throws — the server should still come up even if
 *     no inbox can be watched.
 */
export async function recoverInboxWatchers(opts: { dbUrl?: string } = {}): Promise<void> {
  let inboxes: ForgeInboxRow[];
  try {
    inboxes = await listActiveInboxes(opts);
  } catch (err) {
    logger.error({ err }, 'forge-inbox: recoverInboxWatchers list failed');
    return;
  }
  for (const inbox of inboxes) {
    try {
      await startInboxWatcher(inbox);
    } catch (err) {
      logger.warn(
        { err, inboxId: inbox.id, path: inbox.path },
        'forge-inbox: recover startInboxWatcher threw',
      );
    }
  }
  logger.info({ count: inboxes.length }, 'forge-inbox: recovery complete');
}

/**
 * Stop every active watcher. Called from instrumentation.ts on
 * SIGTERM/SIGINT.
 */
export async function shutdownAllInboxWatchers(): Promise<void> {
  const ids = [...watchers.keys()];
  await Promise.all(ids.map((id) => stopInboxWatcher(id)));
}

// ---------------------------------------------------------------------------
// Test introspection helpers
// ---------------------------------------------------------------------------

/** Number of currently-active watchers. Test-only seam. */
export function activeWatcherCount(): number {
  return watchers.size;
}

/** Whether a watcher for the given id is currently active. Test-only seam. */
export function hasActiveWatcher(inboxId: string): boolean {
  return watchers.has(inboxId);
}

/** Path the active watcher is watching. Test-only seam. */
export function activeWatcherPath(inboxId: string): string | undefined {
  return watchers.get(inboxId)?.path;
}
