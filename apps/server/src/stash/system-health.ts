/**
 * system-health.ts — Typed system-health event emitter — V2-002-T5
 *
 * A lightweight, singleton diagnostics channel for the reconciler and related
 * stash subsystems. Future surfaces (T13 Ledger, observability endpoints) wire
 * in via `onSystemHealth`.
 *
 * Design:
 *   - Singleton module (functions exported directly — no class/instance required).
 *   - Backed by a Set<listener> — O(1) add/remove, deterministic order.
 *   - Listener errors are fault-isolated (same pattern as FileWatcher.emit).
 *   - Also logs to pino at appropriate level per event kind.
 */

import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SystemHealthEvent =
  | { kind: 'fs-unreachable'; stashRootId: string; path: string; error: Error }
  | { kind: 'fs-recovered'; stashRootId: string; path: string }
  | { kind: 'reconciler-started'; stashRootId: string }
  | {
      kind: 'reconciler-stopped';
      stashRootId: string;
      reason: 'shutdown' | 'error';
      error?: Error;
    };

type SystemHealthListener = (e: SystemHealthEvent) => void;

// ---------------------------------------------------------------------------
// Singleton listener registry
// ---------------------------------------------------------------------------

const listeners = new Set<SystemHealthListener>();

/**
 * Subscribe to system-health events. Returns an unsubscribe function.
 * Multiple listeners are allowed; each receives every event independently.
 */
export function onSystemHealth(listener: SystemHealthListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Emit a system-health event to all registered listeners and to pino.
 * Listener errors are caught and discarded (fault isolation).
 */
export function emitSystemHealth(event: SystemHealthEvent): void {
  // Log to pino at the appropriate level.
  switch (event.kind) {
    case 'fs-unreachable':
      logger.warn(
        { stashRootId: event.stashRootId, path: event.path, err: event.error },
        'stash root filesystem unreachable',
      );
      break;
    case 'fs-recovered':
      logger.info(
        { stashRootId: event.stashRootId, path: event.path },
        'stash root filesystem recovered',
      );
      break;
    case 'reconciler-started':
      logger.info(
        { stashRootId: event.stashRootId },
        'reconciler started',
      );
      break;
    case 'reconciler-stopped':
      if (event.reason === 'error') {
        logger.warn(
          { stashRootId: event.stashRootId, err: event.error },
          'reconciler stopped due to error',
        );
      } else {
        logger.info(
          { stashRootId: event.stashRootId },
          'reconciler stopped (shutdown)',
        );
      }
      break;
  }

  // Dispatch to listeners with fault isolation.
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Subscriber errors must not affect sibling subscribers or the emitter.
      // Intentionally swallowed — this is a fault-isolation boundary.
    }
  }
}

/**
 * @internal Test helper — clear all listeners.
 * Not for production use.
 */
export function _clearSystemHealthListeners(): void {
  listeners.clear();
}
