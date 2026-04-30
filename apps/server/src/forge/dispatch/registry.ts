/**
 * registry.ts — V2-005d-a T_da4
 *
 * Map-backed in-memory registry of DispatchHandlers, keyed by `handler.kind`.
 * Future tasks (T_da5+) plug protocol-specific adapters in at app startup.
 *
 * Mirrors the V2-003 ScavengerRegistry pattern (apps/server/src/scavengers/
 * registry.ts): factory function returns a fresh instance, plus a
 * process-level singleton accessor for production wiring. Map iteration order
 * is insertion order — `list()` relies on that.
 *
 * HMR safety: the singleton is stored in a module-level let. Next.js dev HMR
 * may evict and re-create the module, in which case the singleton is rebuilt
 * fresh on the next call — handlers must be re-registered by the wiring layer
 * each module load. Production never reloads the module, so production sees a
 * single stable registry for the process lifetime.
 *
 * Pure in-memory module — no DB, filesystem, or network.
 */
import { logger } from '@/logger';

import type { DispatchHandler } from './handler';

export interface DispatchHandlerRegistry {
  /** Register a handler. Re-registering the same `kind` replaces and warns. */
  register(handler: DispatchHandler): void;
  /** Return the handler registered for `kind`, or null. */
  get(kind: string): DispatchHandler | null;
  /** All registered handlers in insertion order. */
  list(): DispatchHandler[];
  /** Empty the registry. Intended for test cleanup. */
  clear(): void;
}

/**
 * Create a fresh DispatchHandlerRegistry instance. Tests should use this for
 * isolation rather than mutating the process singleton.
 */
export function createDispatchHandlerRegistry(): DispatchHandlerRegistry {
  const handlers = new Map<string, DispatchHandler>();

  return {
    register(handler: DispatchHandler): void {
      if (handlers.has(handler.kind)) {
        logger.warn(
          { kind: handler.kind },
          'DispatchHandlerRegistry: duplicate registration for kind — replacing existing handler',
        );
      }
      handlers.set(handler.kind, handler);
    },

    get(kind: string): DispatchHandler | null {
      return handlers.get(kind) ?? null;
    },

    list(): DispatchHandler[] {
      return Array.from(handlers.values());
    },

    clear(): void {
      handlers.clear();
    },
  };
}

// Module-level singleton. Lazy-created on first `getDefaultRegistry()` call.
// See the "HMR safety" note in the module-level docblock above.
let defaultRegistry: DispatchHandlerRegistry | null = null;

/**
 * Process-singleton DispatchHandlerRegistry. First call lazy-creates it;
 * subsequent calls return the same instance. Production wiring uses this;
 * tests should prefer `createDispatchHandlerRegistry()` for isolation, or
 * call `clear()` between cases.
 */
export function getDefaultRegistry(): DispatchHandlerRegistry {
  if (defaultRegistry === null) {
    defaultRegistry = createDispatchHandlerRegistry();
  }
  return defaultRegistry;
}
