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
   * **IMPORTANT:** In chokidar v4, string entries are **exact-path matches**
   * (NOT globs). For pattern-based ignores, use a `RegExp` or a predicate
   * function `(path: string) => boolean`.
   *
   * Examples:
   *   - `[/\.DS_Store$/]`                 — ignore all .DS_Store files
   *   - `[/\/(\.git)(\/|$)/]`             — ignore .git directories
   *   - `[(path) => path.endsWith('.tmp')]` — ignore any file ending in .tmp
   *
   * Defaults to an empty list (nothing ignored).
   */
  ignored?: Array<string | RegExp | ((path: string) => boolean)>;
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
  /**
   * @internal test-only — inject a fake chokidar factory to simulate startup
   * errors, missing ready events, etc. Production code must not set this.
   */
  _watchFactory?: (
    paths: string[],
    options: ChokidarOptions,
  ) => FSWatcher;
};

/** Watcher instance — a lightweight handle around a chokidar FSWatcher. */
export interface FileWatcher {
  /**
   * Start the underlying chokidar watcher. Returns when chokidar is running
   * (i.e. the 'ready' event has fired for the initial scan).
   *
   * Calling start() a second time (while the watcher is already running) is a
   * no-op (idempotent).
   *
   * **Not callable after stop() — throws.** Create a new instance if you need
   * to restart (e.g. after a filesystem outage). The rejection surfaces the
   * dead state to callers instead of silently returning a resolved promise on
   * a watcher that will never emit.
   *
   * Rejects if chokidar errors before the initial scan completes (e.g.
   * watching a non-existent path). Callers should handle rejection and
   * discard the instance.
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
    _watchFactory = chokidarWatch,
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

  /**
   * Tracks whether chokidar's initial `'ready'` event has fired. Used by the
   * error handler to decide whether an error should reject the start/ready
   * promises (pre-ready) or just emit to listeners (post-ready runtime error).
   */
  let readyFired = false;

  /**
   * Dispatch an event to all current listeners. Listener errors are caught
   * and discarded to guarantee fault isolation — one faulty subscriber must
   * not skip siblings or leak exceptions into chokidar's internal state.
   */
  function emit(event: WatcherEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Subscriber errors must not affect sibling subscribers or chokidar.
        // Intentionally swallowed — this is a fault-isolation boundary.
      }
    }
  }

  function start(): Promise<void> {
    // Cannot restart after stop(). Throw synchronously so callers retrying
    // after a filesystem outage see the dead state instead of a silently
    // resolved promise on a watcher that will never emit.
    if (stopped) {
      throw new Error(
        'FileWatcher cannot be restarted after stop(); create a new instance',
      );
    }
    // Idempotent: if already started, return a resolved promise.
    if (fsw !== null) {
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

      fsw = _watchFactory(paths, chokidarOptions);

      fsw.on('add', (filePath, stats) => {
        if (stopped) return;
        if (stats) {
          emit({ kind: 'add', path: filePath, size: stats.size, mtime: stats.mtime });
        } else {
          // Defensive — chokidar + awaitWriteFinish virtually always supply
          // stats on Linux/macOS. This branch is for the rare case where the
          // stat lookup has timed out or been skipped. Untestable in practice
          // without stubbing internals; surfaces as an error event rather than
          // silently dropping the event.
          emit({ kind: 'error', error: new Error('stats unavailable'), path: filePath });
        }
      });

      fsw.on('change', (filePath, stats) => {
        if (stopped) return;
        if (stats) {
          emit({ kind: 'change', path: filePath, size: stats.size, mtime: stats.mtime });
        } else {
          // Same defensive branch as for 'add' above.
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
        if (!readyFired) {
          // Pre-ready error: chokidar never reached the initial-scan complete
          // state. Reject BOTH promises so `start()` and any `ready()` awaiter
          // unblock. Without rejecting the inner reject(), start() would hang
          // forever waiting on the 'ready' event that will never come.
          reject(error);
          readyReject(error);
        }
        // Post-ready errors are runtime events — emitted to listeners only.
      });

      fsw.on('ready', () => {
        readyFired = true;
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
