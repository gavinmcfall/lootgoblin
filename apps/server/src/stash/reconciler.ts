/**
 * reconciler.ts — Reconciliation engine — V2-002-T5
 *
 * Wires up a FileWatcher per stash root, debounces watcher events, runs the
 * drift classifier, and applies drift-resolution policy.
 *
 * Two drift-detection paths:
 *   1. Watcher-event-driven: targeted classify on changed/added/removed paths.
 *   2. Scheduled full rescan: walks the full FS tree + compares against DB.
 *
 * Constraints (from task brief):
 *   - No DB transaction for full-rescan (apply per-row updates).
 *   - No Ledger events yet — pino logs only. T13 hooks in later.
 *   - In-memory added-externally buffer: per-root, cap 100.
 *   - start() after stop() throws — inherits T4's FileWatcher invariant.
 *   - Rescans after fs-unreachable do NOT mutate DB.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { sha256Hex } from './filesystem-adapter';
import { createFileWatcher } from './file-watcher';
import type { WatcherEvent, FileWatcher } from './file-watcher';
import { classifyDrift } from './drift-classifier';
import type { FsEntry, DbLootFileEntry } from './drift-classifier';
import { emitSystemHealth, _clearSystemHealthListeners } from './system-health';
import { persistLedgerEvent } from './ledger';

// ---------------------------------------------------------------------------
// Re-export for external consumers
// ---------------------------------------------------------------------------
export type { FsEntry, DbLootFileEntry };
export { _clearSystemHealthListeners };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DriftResolutionPolicy = {
  onRemovedExternally(lootFileId: string, lootId: string, path: string): Promise<void>;
  onContentChanged(
    lootFileId: string,
    lootId: string,
    path: string,
    newHash: string,
    newSize: number,
  ): Promise<void>;
  onAddedExternally(stashRootId: string, fsEntry: FsEntry): Promise<void>;
};

export type ReconcilerOptions = {
  /** Stash roots to reconcile. Each gets its own FileWatcher. */
  stashRoots: Array<{ id: string; path: string }>;
  /**
   * Debounce window for event-driven drift evaluation (ms).
   * Multiple watcher events within this window coalesce into a single
   * classification pass over the affected paths. Defaults to 500.
   */
  eventDebounceMs?: number;
  /**
   * Full-rescan interval (ms). Defaults to 300_000 (5 minutes).
   * Set to 0 to disable.
   */
  rescanIntervalMs?: number;
  /**
   * Optional injected drift-resolution policy — for tests.
   * Production uses the default destructive+content-drift policy.
   */
  policy?: DriftResolutionPolicy;
};

export interface Reconciler {
  /** Starts all watchers + scheduler. Resolves when all watchers are ready. */
  start(): Promise<void>;
  /** Stops watchers + scheduler. Idempotent. */
  stop(): Promise<void>;
  /** Manual trigger: full rescan of all stash roots. Returns when done. */
  rescan(): Promise<ReconciliationReport>;
  /** Returns the most recent report (empty if no rescan has run yet). */
  lastReport(): ReconciliationReport | null;
}

export type ReconciliationReport = {
  timestamp: Date;
  perRoot: Array<{
    stashRootId: string;
    added: number;
    removed: number;
    contentChanged: number;
    matched: number;
    errors: number;
  }>;
};

// ---------------------------------------------------------------------------
// Unreachable error codes (treated as fs-unreachable)
// ---------------------------------------------------------------------------

const UNREACHABLE_CODES = new Set(['ENOENT', 'EACCES', 'EIO', 'EHOSTDOWN']);

function isUnreachableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && UNREACHABLE_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Default production drift-resolution policy
// ---------------------------------------------------------------------------

/**
 * Build the default production drift-resolution policy.
 * Uses the shared DB instance from `getDb()`.
 */
export function createDefaultPolicy(): DriftResolutionPolicy {
  return {
    async onRemovedExternally(lootFileId, lootId, filePath) {
      const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
      // Mark the loot item as file-missing. Do NOT delete the lootFiles row —
      // the row is the authoritative record that "a file was once here with this hash."
      await db
        .update(schema.loot)
        .set({ fileMissing: true, updatedAt: new Date() })
        .where(eq(schema.loot.id, lootId));
      logger.info(
        { lootFileId, lootId, path: filePath },
        'lootFile removed externally; loot.fileMissing set to true',
      );
      // V2-002 T5 carry-forward: persist a ledger event so audit queries
      // grouped by subject see reconciliation drift. actorUserId is null
      // because the reconciler is a system actor (ledger_events.actor_user_id
      // is nullable per schema.ledger.ts for exactly this case). Wrapped
      // defensively: persistLedgerEvent is documented as fire-and-continue
      // (never throws), but the try/catch guarantees any future regression
      // there cannot fail the policy handler and poison a rescan.
      try {
        await persistLedgerEvent({
          kind: 'reconciler.removed-externally',
          subjectType: 'loot-file',
          subjectId: lootFileId,
          payload: { lootId, path: filePath },
        });
      } catch (ledgerErr) {
        logger.warn(
          { ledgerErr, lootFileId, lootId },
          'reconciler: ledger emit failed on removed-externally — primary op unaffected',
        );
      }
    },

    async onContentChanged(lootFileId, lootId, filePath, newHash, newSize) {
      const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
      // Two writes without a transaction. The task brief explicitly forbids
      // wrapping rescans in a transaction (long-running; blocks other work).
      // If a crash hits between the two writes, lootFiles.hash is
      // authoritative and loot.updated_at becomes stale by one update —
      // internally consistent and self-healing on the next rescan/write.
      //
      // Filesystem is the source of truth for bytes — update DB to match.
      await db
        .update(schema.lootFiles)
        .set({ hash: newHash, size: newSize })
        .where(eq(schema.lootFiles.id, lootFileId));
      // Bump loot.updatedAt to surface change in UI / queries.
      await db
        .update(schema.loot)
        .set({ updatedAt: new Date() })
        .where(eq(schema.loot.id, lootId));
      logger.info(
        { lootFileId, lootId, path: filePath, newHash, newSize },
        'lootFile content drifted; DB updated',
      );
      // V2-002 T5 carry-forward: same ledger-event pattern as
      // onRemovedExternally. See the commentary there for rationale.
      try {
        await persistLedgerEvent({
          kind: 'reconciler.content-changed',
          subjectType: 'loot-file',
          subjectId: lootFileId,
          payload: { lootId, path: filePath, newHash, newSize },
        });
      } catch (ledgerErr) {
        logger.warn(
          { ledgerErr, lootFileId, lootId },
          'reconciler: ledger emit failed on content-changed — primary op unaffected',
        );
      }
    },

    async onAddedExternally(stashRootId, fsEntry) {
      // T5 scope: log only. T6 Classifier + T7 Adoption drain the buffer.
      logger.info(
        { stashRootId, path: fsEntry.path, size: fsEntry.size },
        'added-externally: file observed but not in DB',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Per-root state
// ---------------------------------------------------------------------------

type RootState = {
  stashRootId: string;
  rootPath: string;
  watcher: FileWatcher;
  /** Is this root currently reachable (last rescan succeeded)? */
  reachable: boolean;
  /** Debounce timer handle. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Buffer of pending watcher events waiting for debounce to flush. */
  pendingEvents: Map<
    string,
    { kind: 'add' | 'change' | 'unlink' | 'unlinkDir'; event: WatcherEvent }
  >;
  /**
   * Per-root buffer of added-externally FS entries. Cap: 100 entries,
   * first-come-first-served — the 101st and beyond are silently dropped
   * until the buffer is drained. T6 Classifier / T7 Adoption are the
   * intended consumers; both must be prepared for this limit.
   *
   * The buffer is in-memory only — on process restart, any undrained
   * entries are lost. The pino log trail written by the default policy's
   * `onAddedExternally` is the durable record; T7 can backfill from logs
   * or introduce a `discovered_files` table when adoption lands.
   */
  addedExternallyBuffer: FsEntry[];
};

// ---------------------------------------------------------------------------
// FS walking helper
// ---------------------------------------------------------------------------

/**
 * Recursively walk a directory, returning all regular-file paths relative to
 * the stash root. Uses `fs.promises.readdir` with `recursive: true` (Node 20+).
 * Returns null on unreachable-style errors.
 */
async function walkStashRoot(rootPath: string): Promise<{ relPath: string; absolutePath: string }[] | null> {
  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await fsPromises.readdir(rootPath, {
      recursive: true,
      withFileTypes: true,
      encoding: 'utf8',
    });
  } catch (err) {
    if (isUnreachableError(err)) return null;
    throw err;
  }

  const files: { relPath: string; absolutePath: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // entry.parentPath (Node 20+) gives the directory containing the entry.
    const parentPath = (entry as typeof entry & { parentPath?: string }).parentPath ?? rootPath;
    const absolutePath = path.join(parentPath, entry.name);
    const relPath = path.relative(rootPath, absolutePath).split(path.sep).join('/');
    files.push({ relPath, absolutePath });
  }
  return files;
}

// ---------------------------------------------------------------------------
// DB query helpers
// ---------------------------------------------------------------------------

type DbEntry = { id: string; lootId: string; path: string; size: number; hash: string };

async function queryDbEntriesForRoot(stashRootId: string): Promise<DbEntry[]> {
  const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  // Join lootFiles → loot → collections to filter by stashRootId.
  const rows = await db
    .select({
      id: schema.lootFiles.id,
      lootId: schema.lootFiles.lootId,
      path: schema.lootFiles.path,
      size: schema.lootFiles.size,
      hash: schema.lootFiles.hash,
    })
    .from(schema.lootFiles)
    .innerJoin(schema.loot, eq(schema.lootFiles.lootId, schema.loot.id))
    .innerJoin(schema.collections, eq(schema.loot.collectionId, schema.collections.id))
    .where(eq(schema.collections.stashRootId, stashRootId));
  return rows as DbEntry[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReconciler(options: ReconcilerOptions): Reconciler {
  const {
    stashRoots,
    eventDebounceMs = 500,
    rescanIntervalMs = 300_000,
    policy = createDefaultPolicy(),
  } = options;

  let started = false;
  let stopped = false;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  let latestReport: ReconciliationReport | null = null;
  /**
   * In-flight full-rescan promise. When non-null, a rescan is running; any
   * subsequent `rescan()` or scheduler tick piggybacks on the existing run
   * rather than starting a second concurrent pass. Prevents double-invocation
   * of policy callbacks and races on `latestReport` when a manual
   * `rescan()` overlaps a scheduler tick (or vice versa).
   */
  let inFlightRescan: Promise<ReconciliationReport> | null = null;

  const rootStates = new Map<string, RootState>();

  // ---------------------------------------------------------------------------
  // Single-root full rescan
  // ---------------------------------------------------------------------------

  async function rescanRoot(state: RootState): Promise<ReconciliationReport['perRoot'][0]> {
    const counter = { added: 0, removed: 0, contentChanged: 0, matched: 0, errors: 0 };

    // Walk the filesystem.
    let files: { relPath: string; absolutePath: string }[] | null;
    try {
      files = await walkStashRoot(state.rootPath);
    } catch (err) {
      counter.errors++;
      // Only emit on the first detection of unreachability; suppress repeat
      // emissions while the root stays unreachable. Matches the files===null
      // branch below so the two paths can't double-emit.
      if (state.reachable !== false) {
        emitSystemHealth({
          kind: 'fs-unreachable',
          stashRootId: state.stashRootId,
          path: state.rootPath,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        state.reachable = false;
      }
      return { stashRootId: state.stashRootId, ...counter };
    }

    if (files === null) {
      // Unreachable-error from walkStashRoot.
      counter.errors++;
      if (state.reachable !== false) {
        emitSystemHealth({
          kind: 'fs-unreachable',
          stashRootId: state.stashRootId,
          path: state.rootPath,
          error: new Error(`Stash root unreachable: ${state.rootPath}`),
        });
      }
      state.reachable = false;
      return { stashRootId: state.stashRootId, ...counter };
    }

    // If previously unreachable, emit recovery signal.
    if (state.reachable === false) {
      emitSystemHealth({ kind: 'fs-recovered', stashRootId: state.stashRootId, path: state.rootPath });
    }
    state.reachable = true;

    // Build FS snapshot — compute hashes eagerly.
    const fsEntries: FsEntry[] = [];
    for (const { relPath, absolutePath } of files) {
      let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
      let hash: string;
      try {
        stat = await fsPromises.stat(absolutePath);
        hash = await sha256Hex(absolutePath);
      } catch (err) {
        logger.warn(
          { stashRootId: state.stashRootId, path: relPath, err },
          'could not stat/hash file during rescan; skipping',
        );
        counter.errors++;
        continue;
      }
      fsEntries.push({ path: relPath, size: stat.size, hash, mtime: stat.mtime });
    }

    // Query DB snapshot.
    let dbRows: DbEntry[];
    try {
      dbRows = await queryDbEntriesForRoot(state.stashRootId);
    } catch (err) {
      logger.error({ stashRootId: state.stashRootId, err }, 'DB query failed during rescan');
      counter.errors++;
      return { stashRootId: state.stashRootId, ...counter };
    }

    const dbEntries: DbLootFileEntry[] = dbRows.map((r) => ({
      lootFileId: r.id,
      lootId: r.lootId,
      path: r.path,
      size: r.size,
      hash: r.hash,
    }));

    const verdicts = classifyDrift(fsEntries, dbEntries);

    // Apply policy and tally counters.
    for (const verdict of verdicts) {
      try {
        switch (verdict.kind) {
          case 'matched':
            counter.matched++;

            // If this path was previously fileMissing=true in DB, un-flag it.
            // Look up the loot row via the lootFileId and reset fileMissing.
            {
              const dbEntry = dbEntries.find((e) => e.lootFileId === verdict.lootFileId);
              if (dbEntry) {
                const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
                // Check if fileMissing is currently true.
                const lootRow = await db
                  .select({ fileMissing: schema.loot.fileMissing })
                  .from(schema.loot)
                  .where(eq(schema.loot.id, dbEntry.lootId))
                  .limit(1);
                if (lootRow[0]?.fileMissing === true) {
                  await db
                    .update(schema.loot)
                    .set({ fileMissing: false, updatedAt: new Date() })
                    .where(eq(schema.loot.id, dbEntry.lootId));
                  logger.info(
                    { lootId: dbEntry.lootId, path: verdict.path },
                    'file restored; loot.fileMissing cleared',
                  );
                }
              }
            }
            break;

          case 'added-externally':
            counter.added++;
            // Buffer per-root, cap 100.
            if (state.addedExternallyBuffer.length < 100) {
              state.addedExternallyBuffer.push(verdict.fsEntry);
            }
            await policy.onAddedExternally(state.stashRootId, verdict.fsEntry);
            break;

          case 'removed-externally':
            counter.removed++;
            await policy.onRemovedExternally(verdict.lootFileId, verdict.lootId, verdict.path);
            break;

          case 'content-changed':
            counter.contentChanged++;
            await policy.onContentChanged(
              verdict.lootFileId,
              verdict.lootId,
              verdict.path,
              verdict.fsEntry.hash!,
              verdict.fsEntry.size,
            );
            break;
        }
      } catch (err) {
        logger.error(
          { stashRootId: state.stashRootId, verdict, err },
          'policy handler threw during rescan; continuing',
        );
        counter.errors++;
      }
    }

    return { stashRootId: state.stashRootId, ...counter };
  }

  // ---------------------------------------------------------------------------
  // Full rescan (all roots)
  // ---------------------------------------------------------------------------

  async function doFullRescan(): Promise<ReconciliationReport> {
    const perRoot: ReconciliationReport['perRoot'] = [];
    for (const [, state] of rootStates) {
      const rootResult = await rescanRoot(state);
      perRoot.push(rootResult);
    }
    const report: ReconciliationReport = { timestamp: new Date(), perRoot };
    latestReport = report;
    return report;
  }

  /**
   * Re-entrancy-safe wrapper around `doFullRescan`. If a rescan is already
   * running, piggyback on the existing promise so every caller gets a real
   * (fresh) report without launching a second concurrent pass.
   */
  function runFullRescan(): Promise<ReconciliationReport> {
    if (inFlightRescan !== null) return inFlightRescan;
    inFlightRescan = doFullRescan().finally(() => {
      inFlightRescan = null;
    });
    return inFlightRescan;
  }

  // ---------------------------------------------------------------------------
  // Event-driven targeted classify
  // ---------------------------------------------------------------------------

  function flushDebounceBuffer(state: RootState): void {
    const pending = new Map(state.pendingEvents);
    state.pendingEvents.clear();
    state.debounceTimer = null;

    // Process each pending event. Fire-and-forget — the debounce timer has
    // already been cleared, and the caller does not await this work.
    void (async () => {
      for (const [filePath, { kind, event }] of pending) {
        try {
          if (kind === 'unlink' || kind === 'unlinkDir') {
            // File was removed — find DB entry and apply removed-externally.
            const relPath = path.relative(state.rootPath, filePath).split(path.sep).join('/');
            const dbRows = await queryDbEntriesForRoot(state.stashRootId);
            const dbEntry = dbRows.find((r) => r.path === relPath);
            if (dbEntry) {
              await policy.onRemovedExternally(dbEntry.id, dbEntry.lootId, relPath);
            }
          } else if (kind === 'add') {
            // New file detected — classify as added-externally.
            const relPath = path.relative(state.rootPath, filePath).split(path.sep).join('/');
            let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
            let hash: string;
            try {
              stat = await fsPromises.stat(filePath);
              hash = await sha256Hex(filePath);
            } catch {
              // File disappeared between event and processing — skip.
              continue;
            }
            const fsEntry: FsEntry = { path: relPath, size: stat.size, hash, mtime: stat.mtime };
            const dbRows = await queryDbEntriesForRoot(state.stashRootId);
            const dbEntry = dbRows.find((r) => r.path === relPath);

            if (!dbEntry) {
              // Added externally.
              if (state.addedExternallyBuffer.length < 100) {
                state.addedExternallyBuffer.push(fsEntry);
              }
              await policy.onAddedExternally(state.stashRootId, fsEntry);
            }
            // If it IS in DB, it was an initial-adds backfill event — ignore.
          } else if (kind === 'change') {
            // File changed — classify as content-changed.
            const relPath = path.relative(state.rootPath, filePath).split(path.sep).join('/');
            let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
            let hash: string;
            try {
              stat = await fsPromises.stat(filePath);
              hash = await sha256Hex(filePath);
            } catch {
              continue;
            }
            const fsEntry: FsEntry = { path: relPath, size: stat.size, hash, mtime: stat.mtime };
            const dbRows = await queryDbEntriesForRoot(state.stashRootId);
            const dbEntry = dbRows.find((r) => r.path === relPath);

            if (dbEntry && hash !== dbEntry.hash) {
              await policy.onContentChanged(dbEntry.id, dbEntry.lootId, relPath, hash, stat.size);
            } else if (!dbEntry) {
              // Not in DB — treat as added-externally.
              if (state.addedExternallyBuffer.length < 100) {
                state.addedExternallyBuffer.push(fsEntry);
              }
              await policy.onAddedExternally(state.stashRootId, fsEntry);
            }
          }
        } catch (err) {
          logger.error(
            { stashRootId: state.stashRootId, path: filePath, kind, err },
            'event-driven classify failed; skipping',
          );
        }
        void event; // suppress unused warning
      }
    })();
  }

  function scheduleDebounce(state: RootState): void {
    if (state.debounceTimer !== null) {
      clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = setTimeout(() => flushDebounceBuffer(state), eventDebounceMs);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async function start(): Promise<void> {
    if (stopped) {
      throw new Error(
        'Reconciler cannot be restarted after stop(); create a new instance',
      );
    }
    if (started) return;
    started = true;

    // Create a FileWatcher + RootState for each stash root.
    for (const root of stashRoots) {
      const watcher = createFileWatcher({
        paths: [root.path],
        ignored: [/\/\.git(\/|$)/, /\.DS_Store$/],
        stabilityThresholdMs: 2000,
        pollIntervalMs: 100,
        emitInitialAdds: true,
      });

      const state: RootState = {
        stashRootId: root.id,
        rootPath: root.path,
        watcher,
        reachable: true,
        debounceTimer: null,
        pendingEvents: new Map(),
        addedExternallyBuffer: [],
      };

      rootStates.set(root.id, state);

      // Subscribe to events.
      watcher.onEvent((event) => {
        if (event.kind === 'error') {
          logger.warn(
            { stashRootId: root.id, err: event.error },
            'file watcher error',
          );
          return;
        }
        // Buffer the event keyed by absolute path; later events overwrite earlier ones.
        const eventPath = event.path;
        state.pendingEvents.set(eventPath, { kind: event.kind, event });
        scheduleDebounce(state);
      });

      emitSystemHealth({ kind: 'reconciler-started', stashRootId: root.id });

      // Start the watcher — don't fail hard if the root doesn't exist.
      try {
        await watcher.start();
      } catch (err) {
        logger.warn(
          { stashRootId: root.id, path: root.path, err },
          'file watcher failed to start; root may be unreachable',
        );
        emitSystemHealth({
          kind: 'fs-unreachable',
          stashRootId: root.id,
          path: root.path,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        state.reachable = false;
      }
    }

    // Run an immediate full rescan.
    await runFullRescan();

    // Schedule periodic rescans (if enabled).
    if (rescanIntervalMs > 0) {
      rescanTimer = setInterval(() => {
        void runFullRescan();
      }, rescanIntervalMs);
    }
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;

    if (rescanTimer !== null) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }

    for (const [, state] of rootStates) {
      if (state.debounceTimer !== null) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }
      try {
        await state.watcher.stop();
      } catch (err) {
        logger.warn(
          { stashRootId: state.stashRootId, err },
          'error stopping file watcher during reconciler shutdown',
        );
      }
      emitSystemHealth({
        kind: 'reconciler-stopped',
        stashRootId: state.stashRootId,
        reason: 'shutdown',
      });
    }
  }

  function rescan(): Promise<ReconciliationReport> {
    return runFullRescan();
  }

  function lastReport(): ReconciliationReport | null {
    return latestReport;
  }

  return { start, stop, rescan, lastReport };
}
