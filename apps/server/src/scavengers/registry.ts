/**
 * Scavenger adapter registry.
 *
 * Maintains the set of registered ScavengerAdapters and routes URLs + ids
 * to the correct adapter. Adapters are registered at application startup
 * (wired in the instrumentation / DI layer).
 *
 * No DB, HTTP, or filesystem imports. Pure in-memory map.
 */

import { logger } from '../logger';
import type { ScavengerAdapter, SourceId } from './types';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ScavengerRegistry {
  /**
   * Register an adapter.
   * If an adapter with the same id is already registered, the old registration
   * is replaced and a warn log is emitted (defensive against duplicate wiring).
   */
  register(adapter: ScavengerAdapter): void;

  /**
   * Return the first adapter whose `supports(url)` returns true, or null if
   * none matches.
   *
   * When two adapters both claim the same URL (misconfiguration), the first
   * registered adapter wins. A warn log is emitted for diagnostics.
   */
  resolveUrl(url: string): ScavengerAdapter | null;

  /**
   * Return the adapter registered under the given id, or null if not found.
   */
  getById(id: SourceId): ScavengerAdapter | null;

  /**
   * List all registered adapter ids in registration order.
   * Used by the sources API route to advertise supported sources.
   */
  list(): SourceId[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new in-memory ScavengerRegistry instance.
 *
 * Adapter ids are stored in insertion order. `list()` preserves that order.
 */
export function createRegistry(): ScavengerRegistry {
  // Map preserves insertion order — `list()` can use Map iteration directly.
  const adapters = new Map<SourceId, ScavengerAdapter>();

  return {
    register(adapter: ScavengerAdapter): void {
      if (adapters.has(adapter.id)) {
        logger.warn(
          { sourceId: adapter.id },
          'ScavengerRegistry: duplicate registration for sourceId — replacing existing adapter',
        );
      }
      adapters.set(adapter.id, adapter);
    },

    resolveUrl(url: string): ScavengerAdapter | null {
      let first: ScavengerAdapter | null = null;
      let matchCount = 0;

      for (const adapter of adapters.values()) {
        if (adapter.supports(url)) {
          matchCount++;
          if (first === null) {
            first = adapter;
          } else if (matchCount === 2) {
            // Warn once when we discover the second match.
            logger.warn(
              { url, firstId: first.id, secondId: adapter.id },
              'ScavengerRegistry: multiple adapters claim the same URL — first-registered wins',
            );
            // Break after discovering the second match — first-registered adapter is
            // already captured in `first`; iterating further adds no value.
            break;
          }
        }
      }

      return first;
    },

    getById(id: SourceId): ScavengerAdapter | null {
      return adapters.get(id) ?? null;
    },

    list(): SourceId[] {
      return Array.from(adapters.keys());
    },
  };
}
