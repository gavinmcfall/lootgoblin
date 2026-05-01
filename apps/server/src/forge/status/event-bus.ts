/**
 * event-bus.ts — V2-005f-T_dcf12
 *
 * In-memory pub/sub for live StatusEvents, keyed by dispatchJobId. The
 * status sink (T_dcf10 status-event-handler) calls `emit()` after persisting
 * each event; SSE handlers (`/api/v1/forge/dispatch/:id/status/stream`)
 * subscribe to broadcast.
 *
 * Design notes:
 *   - Process-singleton bus shared by the status worker and every SSE
 *     handler in the same Node runtime. `getDefaultStatusEventBus()` is the
 *     production accessor; `resetDefaultStatusEventBus()` exists for tests.
 *   - Per-dispatchJobId Set<listener>: subscribers don't see traffic for
 *     other dispatches.
 *   - Listener-thrown errors are swallowed so one bad subscriber can't
 *     poison the broadcast for the rest. The handler logs upstream when it
 *     calls into us — we don't log here to keep the bus pure.
 *   - `subscribe()` returns an unsubscribe fn; SSE handlers MUST call it on
 *     disconnect (`req.signal.addEventListener('abort', unsub)`) or terminal
 *     event close. Failure to unsubscribe leaks the closure across the
 *     dispatch's lifetime — survivable per-process but undesirable.
 *   - When a Set empties we drop the Map entry so an unbounded stream of
 *     completed dispatches doesn't pile up empty Sets forever.
 */

import type { StatusEvent, StatusEventBus } from './types';

export function createStatusEventBus(): StatusEventBus {
  const listeners = new Map<string, Set<(e: StatusEvent) => void>>();
  return {
    emit(dispatchJobId, event) {
      const set = listeners.get(dispatchJobId);
      if (!set) return;
      // Snapshot to a fresh array so a listener that unsubscribes itself
      // (or another) during dispatch doesn't perturb iteration.
      for (const fn of Array.from(set)) {
        try {
          fn(event);
        } catch {
          /* swallow listener errors — one bad subscriber must not poison the broadcast */
        }
      }
    },
    subscribe(dispatchJobId, listener) {
      let set = listeners.get(dispatchJobId);
      if (!set) {
        set = new Set();
        listeners.set(dispatchJobId, set);
      }
      set.add(listener);
      return () => {
        const s = listeners.get(dispatchJobId);
        if (!s) return;
        s.delete(listener);
        if (s.size === 0) listeners.delete(dispatchJobId);
      };
    },
  };
}

let _defaultBus: StatusEventBus | null = null;

/** Process-singleton bus. Lazy-initialised on first use. */
export function getDefaultStatusEventBus(): StatusEventBus {
  if (_defaultBus === null) {
    _defaultBus = createStatusEventBus();
  }
  return _defaultBus;
}

/** Tests-only — drop the singleton so each test starts with a fresh bus. */
export function resetDefaultStatusEventBus(): void {
  _defaultBus = null;
}
