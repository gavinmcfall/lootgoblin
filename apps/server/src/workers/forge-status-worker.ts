/**
 * forge-status-worker.ts — V2-005f-T_dcf9
 *
 * Lifecycle manager for the per-printer `StatusSubscriber`s introduced in
 * T_dcf3–T_dcf8. Wires the claim worker (`forge-claim-worker.ts`) — which
 * transitions dispatch_jobs into `dispatched` — to the protocol-specific
 * subscribers via the `StatusSubscriberRegistry` (T_dcf9).
 *
 * Behaviour (per the V2-005f plan):
 *
 *   1. Lazy-start. When a dispatch_job enters `dispatched` on a printer the
 *      worker creates exactly one subscriber for that printer (if none is
 *      already running) by looking up the printer's `kind` in the registry,
 *      reading its decrypted credential (V2-005d-a `getCredential`) and
 *      calling `subscriber.start(printer, credential, onEvent)`.
 *
 *   2. Auto-stop with grace. When a dispatch reaches a terminal state, its
 *      jobId is removed from the printer's `activeJobs` set. When the set
 *      becomes empty a 30 s grace timer is scheduled; if a new dispatch
 *      arrives during the grace, the timer is cancelled and the existing
 *      subscriber is reused. Otherwise the timer fires `subscriber.stop()`
 *      and forgets the printer.
 *
 *   3. Reconnect / connectivity. The status worker delegates reconnect to
 *      the subscriber implementations (`_reconnect-base.ts`); they own the
 *      exponential backoff (5 s → 30 s → 60 s → 5 min cap) for the
 *      transport. The worker only sees `start()`/`stop()`/`isConnected()`
 *      plus the `onEvent` stream.
 *
 *   4. Boot resilience. On process restart, T_dcf9's `recover()` queries
 *      `dispatch_jobs WHERE status='dispatched' AND target_kind='printer'`
 *      and replays each row through `notifyDispatched`, re-attaching
 *      subscribers for in-flight prints.
 *
 * onEvent routing: the worker forwards every emitted `StatusEvent` to an
 * injected `onEvent(printerId, event)` sink. The default is a no-op; T_dcf10
 * supplies a real implementation that:
 *   - persists the event to `dispatch_status_events`,
 *   - correlates `event.remoteJobRef` → dispatch_job for terminal events,
 *   - triggers consumption emission (T_dcf11),
 *   - broadcasts via the StatusEventBus (T_dcf12).
 * Correlation lives in T_dcf10 — the worker stays narrow.
 *
 * Concurrency: this worker is single-threaded per process. All public
 * methods are async-safe but assume serial invocation from the claim
 * worker; concurrent `notifyDispatched` calls for the SAME printer will
 * race the subscriber-creation branch. We accept that — the claim worker
 * dispatches one job at a time per row, and the worst case is a brief
 * double-`start()` that the subscriber's idempotent `stop()` cleans up.
 */

import { and, eq } from 'drizzle-orm';

import { logger } from '@/logger';
import { getServerDb, schema } from '@/db/client';
import { getCredential } from '@/forge/dispatch/credentials';

import {
  getDefaultSubscriberRegistry,
  type StatusSubscriberRegistry,
} from '@/forge/status/registry';
import type {
  PrinterRecord,
  StatusEvent,
  StatusSubscriber,
} from '@/forge/status/types';

/**
 * Default grace period before tearing down a subscription after the last
 * dispatch reaches a terminal state. 30 s per the plan — short enough that
 * idle printers free their transports quickly, long enough that a
 * back-to-back dispatch reuses the existing connection without a reconnect
 * round-trip.
 */
const DEFAULT_TEARDOWN_GRACE_MS = 30_000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ForgeStatusWorkerOpts {
  /** Subscriber factory registry. Defaults to the process singleton. */
  registry?: StatusSubscriberRegistry;
  /**
   * Grace period before tearing down a subscription after the last
   * dispatch reaches a terminal state. Defaults to 30 s.
   */
  teardownGraceMs?: number;
  /**
   * Override `setTimeout` (e.g. `vi.advanceTimersByTime`-friendly fakes).
   * Defaults to the global `setTimeout`. Returns are passed through opaquely
   * so node Timeout handles work alongside numeric handles from fake timers.
   */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Override `clearTimeout`. Pairs with `setTimeout`. */
  clearTimeout?: (handle: unknown) => void;
  /** SQLite URL override for tests. Defaults to `getServerDb()`'s default. */
  dbUrl?: string;
  /**
   * Sink for status events. T_dcf10 injects a real implementation here that
   * persists + correlates + broadcasts. Default is a no-op (debug log only)
   * so T_dcf9 can ship in isolation.
   */
  onEvent?: (printerId: string, event: StatusEvent) => void | Promise<void>;
}

export interface ForgeStatusWorker {
  /**
   * Notify the worker that a dispatch_job has entered `dispatched` on the
   * given printer. Lazy-starts a subscriber if none is running for the
   * printer; otherwise just adds the jobId to the active set (and cancels
   * any pending teardown timer).
   */
  notifyDispatched(args: {
    dispatchJobId: string;
    printerId: string;
  }): Promise<void>;
  /**
   * Notify the worker that a dispatch_job has reached a terminal state
   * (completed / failed). Removes the jobId from the printer's active set;
   * when the set becomes empty, schedules the teardown grace timer.
   */
  notifyTerminal(args: {
    dispatchJobId: string;
    printerId: string;
  }): Promise<void>;
  /**
   * Boot recovery: query `dispatch_jobs WHERE status='dispatched' AND
   * target_kind='printer'` and replay each row through `notifyDispatched`.
   * Idempotent — safe to call repeatedly.
   */
  recover(): Promise<void>;
  /**
   * Stop every active subscription and clear all teardown timers. Used
   * during graceful shutdown and in test cleanup. Idempotent.
   */
  stop(): Promise<void>;
  /** Test introspection: how many subscriptions are currently active. */
  activeCount(): number;
  /** Test introspection: is a specific printer being watched? */
  isWatching(printerId: string): boolean;
}

interface ActiveSubscription {
  printerId: string;
  printerKind: string;
  subscriber: StatusSubscriber;
  /**
   * Set of dispatch_job ids currently in `dispatched` on this printer.
   * When this set becomes empty we start the teardown grace timer.
   */
  activeJobs: Set<string>;
  /**
   * Timer handle for the teardown grace period. Cleared if a new dispatch
   * arrives during the grace window or `stop()` is called.
   */
  teardownTimer: unknown | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createForgeStatusWorker(
  opts: ForgeStatusWorkerOpts = {},
): ForgeStatusWorker {
  const registry = opts.registry ?? getDefaultSubscriberRegistry();
  const teardownGraceMs = opts.teardownGraceMs ?? DEFAULT_TEARDOWN_GRACE_MS;
  // Bind to the global timer fns so tests using fake timers see the
  // override; without binding, default `setTimeout` is bare and the node
  // version in @types/node picks the wrong overload union for the return.
  const setTimer = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const onEvent =
    opts.onEvent ??
    ((printerId, event) => {
      logger.debug(
        { printerId, kind: event.kind, remoteJobRef: event.remoteJobRef },
        'forge-status: onEvent (no-op default — T_dcf10 will inject real sink)',
      );
    });

  /** keyed by printers.id */
  const subs = new Map<string, ActiveSubscription>();

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function loadPrinter(printerId: string): Promise<PrinterRecord | null> {
    const db = getServerDb(opts.dbUrl);
    const rows = await db
      .select()
      .from(schema.printers)
      .where(eq(schema.printers.id, printerId))
      .limit(1);
    return rows[0] ?? null;
  }

  function clearTeardown(sub: ActiveSubscription): void {
    if (sub.teardownTimer !== null) {
      clearTimer(sub.teardownTimer);
      sub.teardownTimer = null;
    }
  }

  function scheduleTeardown(sub: ActiveSubscription): void {
    // If a teardown is already pending, leave it — the timer is already
    // counting down and will tear down at the original deadline. Resetting
    // would silently extend the grace, which masks bugs in the caller's
    // notifyTerminal sequencing.
    if (sub.teardownTimer !== null) return;

    sub.teardownTimer = setTimer(() => {
      // Race guard: a notifyDispatched arriving inside this microtask will
      // have set activeJobs.size > 0 already; in that case the cancel-on-
      // dispatch path already cleared the timer and we never get here.
      if (sub.activeJobs.size > 0) {
        sub.teardownTimer = null;
        return;
      }
      void teardown(sub).catch((err) => {
        logger.error(
          { err, printerId: sub.printerId },
          'forge-status: teardown failed',
        );
      });
    }, teardownGraceMs);
  }

  async function teardown(sub: ActiveSubscription): Promise<void> {
    sub.teardownTimer = null;
    try {
      await sub.subscriber.stop();
    } catch (err) {
      logger.warn(
        { err, printerId: sub.printerId, printerKind: sub.printerKind },
        'forge-status: subscriber.stop threw — forgetting subscription anyway',
      );
    }
    // Only delete if the entry is still us — `stop()` may have raced with a
    // new lazy-start that re-bound the slot. (Currently impossible because
    // we await stop() before delete, but cheap to be defensive.)
    if (subs.get(sub.printerId) === sub) {
      subs.delete(sub.printerId);
    }
  }

  async function startSubscription(
    printer: PrinterRecord,
    initialJobId: string,
  ): Promise<void> {
    const factory = registry.get(printer.kind);
    if (!factory) {
      logger.warn(
        { printerId: printer.id, printerKind: printer.kind },
        'forge-status: no StatusSubscriberFactory registered for printer.kind — skipping',
      );
      return;
    }

    const subscriber = factory.create(printer.kind);

    let credential = null;
    try {
      credential = getCredential({ printerId: printer.id, dbUrl: opts.dbUrl });
    } catch (err) {
      // Credential decrypt failures should not block the subscription — the
      // subscriber may still function on transports that don't require auth
      // (e.g. unauthed Moonraker). Log and pass null down.
      logger.warn(
        { err, printerId: printer.id },
        'forge-status: getCredential threw — starting subscriber with credential=null',
      );
    }

    const entry: ActiveSubscription = {
      printerId: printer.id,
      printerKind: printer.kind,
      subscriber,
      activeJobs: new Set([initialJobId]),
      teardownTimer: null,
    };
    subs.set(printer.id, entry);

    try {
      await subscriber.start(printer, credential, (event: StatusEvent) => {
        // Forward to the injected sink. We swallow promise rejections at the
        // sink boundary so a misbehaving sink can't poison the subscriber's
        // event loop.
        try {
          const maybe = onEvent(printer.id, event);
          if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
            (maybe as Promise<void>).catch((err) => {
              logger.error(
                {
                  err,
                  printerId: printer.id,
                  kind: event.kind,
                },
                'forge-status: onEvent sink rejected',
              );
            });
          }
        } catch (err) {
          logger.error(
            { err, printerId: printer.id, kind: event.kind },
            'forge-status: onEvent sink threw',
          );
        }
      });
    } catch (err) {
      logger.error(
        { err, printerId: printer.id, printerKind: printer.kind },
        'forge-status: subscriber.start threw — removing failed subscription',
      );
      // Keep the registry-side state consistent: if start() blew up, drop
      // the entry so a later notifyDispatched can retry from scratch.
      if (subs.get(printer.id) === entry) {
        subs.delete(printer.id);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    async notifyDispatched(args): Promise<void> {
      const existing = subs.get(args.printerId);
      if (existing) {
        existing.activeJobs.add(args.dispatchJobId);
        // Cancel any pending teardown — a fresh job arrived inside the
        // grace window, so we want to keep the connection open.
        clearTeardown(existing);
        return;
      }

      const printer = await loadPrinter(args.printerId);
      if (!printer) {
        logger.warn(
          { printerId: args.printerId, dispatchJobId: args.dispatchJobId },
          'forge-status: notifyDispatched for unknown printer — ignoring',
        );
        return;
      }

      await startSubscription(printer, args.dispatchJobId);
    },

    async notifyTerminal(args): Promise<void> {
      const sub = subs.get(args.printerId);
      if (!sub) return;

      sub.activeJobs.delete(args.dispatchJobId);
      if (sub.activeJobs.size === 0) {
        scheduleTeardown(sub);
      }
    },

    async recover(): Promise<void> {
      const db = getServerDb(opts.dbUrl);
      const rows = await db
        .select({
          id: schema.dispatchJobs.id,
          targetId: schema.dispatchJobs.targetId,
        })
        .from(schema.dispatchJobs)
        .where(
          and(
            eq(schema.dispatchJobs.status, 'dispatched'),
            eq(schema.dispatchJobs.targetKind, 'printer'),
          ),
        );

      if (rows.length === 0) return;

      logger.info(
        { count: rows.length },
        'forge-status: recovering dispatched jobs after restart',
      );

      // Sequential recovery — one printer's startSubscription does a DB
      // read + credential decrypt + transport open. Doing them serially
      // keeps log ordering predictable and avoids a thundering herd of
      // outbound connections at boot.
      for (const row of rows) {
        try {
          await this.notifyDispatched({
            dispatchJobId: row.id,
            printerId: row.targetId,
          });
        } catch (err) {
          logger.error(
            { err, dispatchJobId: row.id, printerId: row.targetId },
            'forge-status: recovery notifyDispatched threw — continuing',
          );
        }
      }
    },

    async stop(): Promise<void> {
      const entries = Array.from(subs.values());
      // Clear timers first so an in-flight teardown can't race with our
      // explicit stop().
      for (const sub of entries) {
        clearTeardown(sub);
      }
      // Stop subscribers in parallel — independent transports, no
      // ordering constraints.
      await Promise.all(
        entries.map(async (sub) => {
          try {
            await sub.subscriber.stop();
          } catch (err) {
            logger.warn(
              {
                err,
                printerId: sub.printerId,
                printerKind: sub.printerKind,
              },
              'forge-status: subscriber.stop threw during shutdown',
            );
          }
        }),
      );
      subs.clear();
    },

    activeCount(): number {
      return subs.size;
    },

    isWatching(printerId: string): boolean {
      return subs.has(printerId);
    },
  };
}
