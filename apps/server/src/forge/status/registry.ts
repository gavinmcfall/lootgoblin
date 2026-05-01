/**
 * registry.ts — V2-005f-T_dcf9
 *
 * Map-backed in-memory registry of `StatusSubscriberFactory`s, keyed by the
 * `printers.kind` string the factory targets (e.g. `fdm_klipper`,
 * `fdm_octoprint`, `bambu_x1c`, `resin_sdcp`, `resin_chitu_network`).
 *
 * Mirrors the V2-005d-a `DispatchHandlerRegistry` (apps/server/src/forge/
 * dispatch/registry.ts) — a factory function returns a fresh instance, plus
 * a process-level singleton accessor for production wiring. T_dcf9's
 * `forge-status-worker` reads from the singleton; tests prefer
 * `createSubscriberRegistry()` for isolation, or `clear()` between cases.
 *
 * HMR safety: the singleton is stored in a module-level let. Next.js dev
 * HMR may evict and re-create the module, in which case the singleton is
 * rebuilt fresh on the next call — factories must be re-registered by the
 * wiring layer each module load. Production never reloads the module, so it
 * sees a single stable registry for the process lifetime.
 *
 * Pure in-memory module — no DB, filesystem, or network.
 */

import { logger } from '@/logger';

import type { StatusSubscriber } from './types';

/**
 * Builds a fresh `StatusSubscriber` instance for a given `printers.kind`.
 * The worker calls `create(printerKind)` once per printer when the first
 * dispatch lands; the returned subscriber's lifecycle is owned by the worker
 * (see `forge-status-worker.ts`).
 *
 * Factories may consult the kind to pick a transport variant (e.g. choose
 * between `bambu_x1c` MQTT shape vs `bambu_a1` MQTT shape) but the typical
 * implementation is a thin closure over the protocol-specific
 * `create<Protocol>Subscriber()` from `./subscribers/*`.
 */
export interface StatusSubscriberFactory {
  /** Build a subscriber instance for a specific `printers.kind`. */
  create(printerKind: string): StatusSubscriber;
}

export interface StatusSubscriberRegistry {
  /** Register a factory. Re-registering the same `printerKind` replaces and warns. */
  register(printerKind: string, factory: StatusSubscriberFactory): void;
  /** Return the factory registered for `printerKind`, or undefined. */
  get(printerKind: string): StatusSubscriberFactory | undefined;
  /** True iff a factory is registered for `printerKind`. */
  has(printerKind: string): boolean;
  /** All registered printerKinds in insertion order. */
  list(): string[];
  /** Empty the registry. Intended for test cleanup. */
  clear(): void;
}

/**
 * Create a fresh `StatusSubscriberRegistry` instance. Tests should use this
 * for isolation rather than mutating the process singleton.
 */
export function createSubscriberRegistry(): StatusSubscriberRegistry {
  const factories = new Map<string, StatusSubscriberFactory>();

  return {
    register(printerKind: string, factory: StatusSubscriberFactory): void {
      if (factories.has(printerKind)) {
        logger.warn(
          { printerKind },
          'StatusSubscriberRegistry: duplicate registration for printerKind — replacing existing factory',
        );
      }
      factories.set(printerKind, factory);
    },

    get(printerKind: string): StatusSubscriberFactory | undefined {
      return factories.get(printerKind);
    },

    has(printerKind: string): boolean {
      return factories.has(printerKind);
    },

    list(): string[] {
      return Array.from(factories.keys());
    },

    clear(): void {
      factories.clear();
    },
  };
}

// Module-level singleton. Lazy-created on first `getDefaultSubscriberRegistry()` call.
// See the "HMR safety" note in the module-level docblock above.
let defaultRegistry: StatusSubscriberRegistry | null = null;

/**
 * Process-singleton `StatusSubscriberRegistry`. First call lazy-creates it;
 * subsequent calls return the same instance. Production wiring uses this;
 * tests should prefer `createSubscriberRegistry()` for isolation, or call
 * `clear()` between cases.
 */
export function getDefaultSubscriberRegistry(): StatusSubscriberRegistry {
  if (defaultRegistry === null) {
    defaultRegistry = createSubscriberRegistry();
  }
  return defaultRegistry;
}

/**
 * Reset the module-level singleton. Tests that exercise the
 * `getDefaultSubscriberRegistry()` accessor itself (rather than passing an
 * explicit registry through opts) should call this in `afterEach` to keep
 * state from leaking across test files.
 */
export function resetDefaultSubscriberRegistry(): void {
  defaultRegistry = null;
}
