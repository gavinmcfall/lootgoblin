/**
 * File watcher abstraction — V2-002-T4
 *
 * A thin, typed wrapper over chokidar that:
 *   - Normalizes filesystem events into a discriminated-union `WatcherEvent`.
 *   - Uses chokidar's built-in awaitWriteFinish to debounce writes-in-progress.
 *   - Exposes a clean lifecycle (start → ready → stop) with multiple subscribers.
 *
 * Design decisions:
 *   - No DB or Drizzle imports — pure fs + chokidar.
 *   - No path normalization — paths are delivered exactly as chokidar emits them
 *     (OS-native separators). Callers use path.join / path.dirname which are
 *     OS-aware. Forward-slash normalization on Windows is the caller's concern.
 *   - No global singleton — one watcher instance per Stash root; lifecycle is
 *     the caller's responsibility (T5 Reconciliation, T8 Inbox Triage).
 *   - No event correlation (rename / move detection) — that's T5's job.
 *   - No event persistence — in-memory only; T5 reconciliation rescan covers drift
 *     across restarts.
 */

import { watch as chokidarWatch } from 'chokidar';
import type { FSWatcher, ChokidarOptions } from 'chokidar';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Normalized event shape emitted by a FileWatcher.
 * `size` and `mtime` are only present for add/change events.
 */
export type WatcherEvent =
  | { kind: 'add'; path: string; size: number; mtime: Date }
  | { kind: 'change'; path: string; size: number; mtime: Date }
  | { kind: 'unlink'; path: string }
  | { kind: 'unlinkDir'; path: string }
  | { kind: 'error'; error: Error; path?: string };

/** Configuration for a watcher instance. */
export type FileWatcherOptions = {
  /**
   * Absolute directory paths to watch. Recursive by default.
   */
  paths: string[];
  /**
   * Patterns to ignore. Uses chokidar's matcher types.
   *
   * **chokidar v4 behavioral note:** String values are **exact-path matches**,
   * not globs. For pattern-based ignores (e.g. all `.DS_Store` files) use a
   * `RegExp` or a function `(path: string) => boolean`. Example:
   *   - `[/\.DS_Store$/]`  — ignore all .DS_Store files
   *   - `[/\/(\.git)(\/|$)/]` — ignore .git directories
   *
   * Defaults to an empty list (nothing ignored).
   */
  ignored?: Array<string | RegExp>;
  /**
   * Max milliseconds to wait after the last modification before emitting
   * an add/change event. Uses chokidar's awaitWriteFinish.stabilityThreshold.
   * Defaults to 2000 (2 seconds).
   */
  stabilityThresholdMs?: number;
  /**
   * Poll interval for the writes-in-progress check. Chokidar's
   * awaitWriteFinish.pollInterval. Defaults to 100.
   */
  pollIntervalMs?: number;
  /**
   * If true, the initial scan emits add events for every existing file.
   * If false, only subsequent changes emit events. Defaults to true.
   *
   * Reconciliation (T5) sets this true.
   * Inbox Triage (T8) sets this false after initial triage.
   */
  emitInitialAdds?: boolean;
};

/** Watcher instance — a lightweight handle around a chokidar FSWatcher. */
export interface FileWatcher {
  /**
   * Start the underlying chokidar watcher. Returns when chokidar is running
   * (i.e. the 'ready' event has fired for the initial scan).
   *
   * Calling start() a second time is a no-op (idempotent).
   */
  start(): Promise<void>;
  /**
   * Promise that resolves when chokidar has finished its initial scan.
   * After `ready()` resolves, subsequent events are "real" (not backfill).
   *
   * May be awaited before or after `start()`.
   */
  ready(): Promise<void>;
  /**
   * Subscribe to normalized events. Returns an unsubscribe function.
   * Multiple listeners are allowed; each gets every event independently.
   */
  onEvent(listener: (event: WatcherEvent) => void): () => void;
  /**
   * Stop the watcher. Releases all filesystem watches and listener references.
   * Safe to call multiple times (idempotent).
   */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a FileWatcher. Does NOT start watching — call start() to begin.
 *
 * @param options - Watcher configuration.
 * @returns A FileWatcher handle.
 */
export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
  const {
    paths,
    ignored = [],
    stabilityThresholdMs = 2000,
    pollIntervalMs = 100,
    emitInitialAdds = true,
  } = options;

  /** Set of active event listeners. */
  const listeners = new Set<(event: WatcherEvent) => void>();

  /** The underlying chokidar FSWatcher instance, null before start() is called. */
  let fsw: FSWatcher | null = null;

  /** Whether the watcher has been stopped. */
  let stopped = false;

  /** Promise (and its resolver) for the initial-scan readiness signal. */
  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  /** Dispatch an event to all current listeners. */
  function emit(event: WatcherEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function start(): Promise<void> {
    // Idempotent: if already started, return a resolved promise.
    if (fsw !== null) {
      return Promise.resolve();
    }
    if (stopped) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const chokidarOptions: ChokidarOptions = {
        persistent: true,
        ignoreInitial: !emitInitialAdds,
        ignored: ignored.length > 0 ? ignored : undefined,
        awaitWriteFinish: {
          stabilityThreshold: stabilityThresholdMs,
          pollInterval: pollIntervalMs,
        },
      };

      fsw = chokidarWatch(paths, chokidarOptions);

      fsw.on('add', (filePath, stats) => {
        if (stopped) return;
        if (stats) {
          emit({ kind: 'add', path: filePath, size: stats.size, mtime: stats.mtime });
        } else {
          emit({ kind: 'error', error: new Error('stats unavailable'), path: filePath });
        }
      });

      fsw.on('change', (filePath, stats) => {
        if (stopped) return;
        if (stats) {
          emit({ kind: 'change', path: filePath, size: stats.size, mtime: stats.mtime });
        } else {
          emit({ kind: 'error', error: new Error('stats unavailable'), path: filePath });
        }
      });

      fsw.on('unlink', (filePath) => {
        if (stopped) return;
        emit({ kind: 'unlink', path: filePath });
      });

      fsw.on('unlinkDir', (filePath) => {
        if (stopped) return;
        emit({ kind: 'unlinkDir', path: filePath });
      });

      fsw.on('error', (unknown) => {
        // chokidar v4 types errHandler as (err: unknown) — normalize to Error.
        const error = unknown instanceof Error ? unknown : new Error(String(unknown));
        emit({ kind: 'error', error });
        // Reject the ready promise if we haven't resolved yet (startup error).
        readyReject(error);
      });

      fsw.on('ready', () => {
        resolve();
        readyResolve();
      });
    });
  }

  function ready(): Promise<void> {
    return readyPromise;
  }

  function onEvent(listener: (event: WatcherEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    listeners.clear();
    if (fsw !== null) {
      await fsw.close();
      fsw = null;
    }
  }

  return { start, ready, onEvent, stop };
}
