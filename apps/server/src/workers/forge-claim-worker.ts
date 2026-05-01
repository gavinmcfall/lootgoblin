/**
 * Forge central-worker claim loop — V2-005a-T4.
 *
 * Drains `dispatch_jobs WHERE status = 'claimable'` for the in-process
 * `central_worker` Agent. Each tick:
 *
 *   1. SELECT the oldest claimable job that this agent can reach.
 *      Reachability rules:
 *        - target_kind = 'slicer'  → always reachable by central
 *          (slicer URLs invoke on the user's device; central just stages
 *          the file. Real dispatch in V2-005e via the slicer-dispatcher seam).
 *        - target_kind = 'printer' → reachable iff a row exists in
 *          printer_reachable_via with (printer_id = target_id, agent_id = central).
 *
 *   2. Atomically claim via dispatch-state.markClaimed (UPDATE ... WHERE
 *      status='claimable' guard; changes===1 wins). Race losers → return
 *      'idle' and the next tick retries.
 *
 *   3. claimed → dispatched via markDispatched.
 *
 *   4. Run the dispatchHandler. The default routes printer-target jobs through
 *      the DispatchHandlerRegistry (V2-005d-a T_da6); slicer-target jobs use
 *      a stub-success path until V2-005e replaces it. Tests can inject a custom
 *      `dispatchHandler` via `runOneClaimTick({ dispatchHandler })` to override
 *      both paths.
 *
 *   5. dispatched → completed (handler.ok) | failed (handler.ok=false or threw).
 *
 * Polling cadence:
 *   - 1.5s base + ±500 ms jitter on idle (matches ingest-worker POLL_BASE_MS)
 *   - exponential backoff 5s → 30s on errors
 *
 * Crash recovery on startup:
 *   - dispatch_jobs.status='claimed' AND claim_marker = central agent id AND
 *     claimed_at < now - 30 min  →  reset to 'claimable' via unclaimStaleJob.
 *   - 30 min default per the V2-005a plan ("Claim-timeout shall default to
 *     30 minutes"). Configurable via WORKER_FORGE_CLAIM_TIMEOUT_MS.
 *
 * Concurrency: 4 parallel claim loops by default. Configurable via
 * WORKER_FORGE_CLAIM_CONCURRENCY. Each loop is a self-contained while-loop
 * sharing the same AbortController for SIGTERM/SIGINT shutdown.
 *
 * Prerequisite: bootstrapCentralWorker must have run before the loop starts.
 * Instrumentation.ts orders the bootstrap call before startForgeClaimWorker;
 * tests must call bootstrapCentralWorker explicitly. Missing-row throws a
 * clear "central_worker agent not bootstrapped — instrumentation order
 * issue" Error.
 */

import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';

import { logger } from '../logger';
import { getServerDb, schema } from '../db/client';
import { sleep } from '../scavengers/rate-limit';
import {
  markClaimed,
  markDispatched,
  markFailed,
  unclaimStaleJob,
} from '../forge/dispatch-state';
import {
  type DispatchFailureReason,
  type DispatchTargetKind,
} from '../db/schema.forge';
import {
  getDefaultRegistry,
  type DispatchHandlerRegistry,
} from '../forge/dispatch/registry';
import { getCredential } from '../forge/dispatch/credentials';
import { mapAdapterReasonToSchema } from '../forge/dispatch/failure-reason-map';
import type { DispatchContext } from '../forge/dispatch/handler';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const POLL_BASE_MS = 1500;
const POLL_JITTER_MS = 500;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 30_000;
/** Default claim timeout — plan-locked at 30 minutes. */
const DEFAULT_CLAIM_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let claimAbort: AbortController | null = null;

export interface DispatchHandlerInput {
  jobId: string;
  targetKind: DispatchTargetKind;
  targetId: string;
  lootId: string;
  ownerId: string;
}

export type DispatchHandlerResult =
  | { ok: true }
  | { ok: false; reason: DispatchFailureReason; details?: string };

export type DispatchHandler = (
  input: DispatchHandlerInput,
) => Promise<DispatchHandlerResult>;

/**
 * Optional hook fired after a dispatch_job successfully transitions
 * `claimed → dispatched`. Wired in instrumentation.ts to
 * `statusWorker.notifyDispatched` so the per-printer status subscriber
 * lazy-starts as soon as the printer has an active dispatch. Tests can
 * override.
 *
 * Contract: best-effort. The hook runs sync-ish (we await it so errors are
 * loggable) but failures inside it MUST NOT affect the dispatch's downstream
 * lifecycle — the rule "we sent the file ≠ the print finished" still holds.
 * Errors are logged and swallowed by the caller.
 */
export type OnJobDispatched = (args: {
  dispatchJobId: string;
  printerId: string;
}) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Look up the in-process central_worker Agent id. Throws a clear error if
 * the bootstrap hasn't run — instrumentation.ts guarantees the order, so
 * this is a contract violation if it fires in production. Tests must call
 * bootstrapCentralWorker before exercising the worker.
 */
async function getCentralWorkerAgentId(dbUrl?: string): Promise<string> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.kind, 'central_worker'))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      'central_worker agent not bootstrapped — instrumentation order issue (call bootstrapCentralWorker before starting the forge claim worker)',
    );
  }
  return row.id;
}

/**
 * Default registry-backed dispatcher (V2-005d-a T_da6).
 *
 * Routes per-job by `targetKind`:
 *   - 'printer' → look up DispatchHandler by `printers.kind` in the
 *     DispatchHandlerRegistry, build a DispatchContext, call handler.dispatch,
 *     translate DispatchOutcome → DispatchHandlerResult.
 *   - 'slicer'  → stub-success (V2-005e replaces this with the slicer
 *     dispatcher).
 *
 * Tests that want to exercise the legacy stub-success path for printer-target
 * jobs can either:
 *   1. Inject a custom `dispatchHandler` via runOneClaimTick({ dispatchHandler })
 *      — the override skips the registry entirely.
 *   2. Pre-register a stub handler in the registry under the relevant
 *      `printer.kind`.
 */
function makeRegistryBackedDispatchHandler(args: {
  registry: DispatchHandlerRegistry;
  dbUrl?: string;
}): DispatchHandler {
  return async (input) => {
    if (input.targetKind === 'slicer') {
      // V2-005e replaces this. The slicer dispatcher will translate the
      // dispatch_job into a slicer-open URL handoff and confirm completion.
      logger.info(
        { jobId: input.jobId, targetId: input.targetId },
        'forge-claim: slicer-target stub dispatcher — V2-005e not yet implemented',
      );
      return { ok: true };
    }

    // targetKind === 'printer'.
    const printer = await loadPrinterForJob(input.targetId, args.dbUrl);
    if (!printer) {
      return {
        ok: false,
        reason: 'unknown',
        details: `printer row not found for targetId=${input.targetId}`,
      };
    }

    const handler = args.registry.get(printer.kind);
    if (!handler) {
      logger.warn(
        { jobId: input.jobId, printerKind: printer.kind },
        'forge-claim: no DispatchHandler registered for printer.kind',
      );
      return {
        ok: false,
        reason: mapAdapterReasonToSchema('unsupported-protocol'),
        details: `no handler registered for printer.kind=${printer.kind}`,
      };
    }

    const artifact = await loadArtifactForJob(input.jobId, args.dbUrl);
    if (!artifact) {
      return {
        ok: false,
        reason: mapAdapterReasonToSchema('unknown'),
        details: 'no forge_artifact found for dispatch job',
      };
    }

    // Decrypt credential (NULL when no row exists). Encryption key sourced from
    // LOOTGOBLIN_SECRET; failures here propagate as 'unknown' so the row goes
    // to a terminal failed state instead of looping forever.
    let credential;
    try {
      credential = getCredential({ printerId: printer.id, dbUrl: args.dbUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { jobId: input.jobId, printerId: printer.id },
        'forge-claim: getCredential threw — treating as no-credentials',
      );
      return {
        ok: false,
        reason: mapAdapterReasonToSchema('unknown'),
        details: `credential decryption failed: ${msg}`,
      };
    }

    const ctx: DispatchContext = {
      job: {
        id: input.jobId,
        ownerId: input.ownerId,
        targetId: input.targetId,
      },
      printer: {
        id: printer.id,
        ownerId: printer.ownerId,
        kind: printer.kind,
        connectionConfig:
          typeof printer.connectionConfig === 'string'
            ? (JSON.parse(printer.connectionConfig) as Record<string, unknown>)
            : (printer.connectionConfig as Record<string, unknown>),
      },
      artifact: {
        storagePath: artifact.storagePath,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      },
      credential,
      // Production HttpClient. globalThis.fetch loses `this` if called bare on
      // some Node versions — bind defensively.
      http: { fetch: globalThis.fetch.bind(globalThis) },
      logger: logger.child({
        jobId: input.jobId,
        printerId: printer.id,
        printerKind: printer.kind,
      }),
    };

    const outcome = await handler.dispatch(ctx);
    if (outcome.kind === 'success') {
      logger.info(
        {
          jobId: input.jobId,
          printerId: printer.id,
          remoteFilename: outcome.remoteFilename,
        },
        'forge-claim: dispatch succeeded',
      );
      return { ok: true };
    }

    const schemaReason = mapAdapterReasonToSchema(outcome.reason);
    logger.warn(
      {
        jobId: input.jobId,
        printerId: printer.id,
        adapterReason: outcome.reason,
        schemaReason,
      },
      'forge-claim: dispatch failed',
    );
    return {
      ok: false,
      reason: schemaReason,
      // Preserve the raw adapter reason in details for forensic inspection.
      details: outcome.details ?? outcome.reason,
    };
  };
}

/** Convenience accessor used by `runOneClaimTick` when no handler is injected. */
function defaultDispatchHandler(dbUrl?: string): DispatchHandler {
  return makeRegistryBackedDispatchHandler({
    registry: getDefaultRegistry(),
    dbUrl,
  });
}

interface PrinterRow {
  id: string;
  ownerId: string;
  kind: string;
  connectionConfig: unknown;
}

async function loadPrinterForJob(
  printerId: string,
  dbUrl?: string,
): Promise<PrinterRow | null> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({
      id: schema.printers.id,
      ownerId: schema.printers.ownerId,
      kind: schema.printers.kind,
      connectionConfig: schema.printers.connectionConfig,
    })
    .from(schema.printers)
    .where(eq(schema.printers.id, printerId))
    .limit(1);
  return rows[0] ?? null;
}

interface ArtifactRow {
  storagePath: string;
  sizeBytes: number;
  sha256: string;
}

async function loadArtifactForJob(
  jobId: string,
  dbUrl?: string,
): Promise<ArtifactRow | null> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({
      storagePath: schema.forgeArtifacts.storagePath,
      sizeBytes: schema.forgeArtifacts.sizeBytes,
      sha256: schema.forgeArtifacts.sha256,
    })
    .from(schema.forgeArtifacts)
    .where(eq(schema.forgeArtifacts.dispatchJobId, jobId))
    .limit(1);
  return rows[0] ?? null;
}

interface ClaimableCandidate {
  id: string;
  ownerId: string;
  lootId: string;
  targetKind: DispatchTargetKind;
  targetId: string;
}

/**
 * SELECT the oldest claimable job reachable by `agentId`.
 *
 * Reachability filter:
 *   - slicer-target jobs are ALWAYS reachable by the central worker.
 *   - printer-target jobs are reachable iff a row exists in
 *     printer_reachable_via with (printer_id = target_id, agent_id = X).
 *
 * Returns null when no candidate exists. Caller still has to win the race
 * via markClaimed (the SELECT is unguarded — concurrent tickers may pick
 * the same row, and the WHERE on markClaimed serialises them).
 */
async function findClaimableCandidate(
  agentId: string,
  dbUrl?: string,
): Promise<ClaimableCandidate | null> {
  const db = getServerDb(dbUrl);
  // Drizzle's left-join + OR query is awkward to express type-safely against
  // an `and(eq(...), eq(...))` JOIN-on clause; we fall back to two queries
  // and merge in app-layer per the task brief's pragmatic guidance. Each
  // query orders by createdAt ASC and limits to 1; we pick the older of the
  // two candidates.

  // Query 1: slicer-target claimable jobs.
  const slicerRows = await db
    .select({
      id: schema.dispatchJobs.id,
      ownerId: schema.dispatchJobs.ownerId,
      lootId: schema.dispatchJobs.lootId,
      targetKind: schema.dispatchJobs.targetKind,
      targetId: schema.dispatchJobs.targetId,
      createdAt: schema.dispatchJobs.createdAt,
    })
    .from(schema.dispatchJobs)
    .where(
      and(
        eq(schema.dispatchJobs.status, 'claimable'),
        eq(schema.dispatchJobs.targetKind, 'slicer'),
      ),
    )
    .orderBy(asc(schema.dispatchJobs.createdAt))
    .limit(1);

  // Query 2: printer-target claimable jobs reachable by this agent.
  const printerRows = await db
    .select({
      id: schema.dispatchJobs.id,
      ownerId: schema.dispatchJobs.ownerId,
      lootId: schema.dispatchJobs.lootId,
      targetKind: schema.dispatchJobs.targetKind,
      targetId: schema.dispatchJobs.targetId,
      createdAt: schema.dispatchJobs.createdAt,
    })
    .from(schema.dispatchJobs)
    .innerJoin(
      schema.printerReachableVia,
      and(
        eq(schema.printerReachableVia.printerId, schema.dispatchJobs.targetId),
        eq(schema.printerReachableVia.agentId, agentId),
      ),
    )
    .where(
      and(
        eq(schema.dispatchJobs.status, 'claimable'),
        eq(schema.dispatchJobs.targetKind, 'printer'),
      ),
    )
    .orderBy(asc(schema.dispatchJobs.createdAt))
    .limit(1);

  const slicer = slicerRows[0];
  const printer = printerRows[0];

  // Pick the older of the two (oldest claimable across kinds wins).
  let pick: typeof slicer | undefined;
  if (slicer && printer) {
    pick = slicer.createdAt <= printer.createdAt ? slicer : printer;
  } else {
    pick = slicer ?? printer;
  }

  if (!pick) return null;
  return {
    id: pick.id,
    ownerId: pick.ownerId,
    lootId: pick.lootId,
    targetKind: pick.targetKind as DispatchTargetKind,
    targetId: pick.targetId,
  };
}

// ---------------------------------------------------------------------------
// runOneClaimTick
// ---------------------------------------------------------------------------

/**
 * One pass of the claim loop. Returns:
 *   'ran'     — claimed + dispatched + reached terminal state for one job
 *   'idle'    — no claimable job available for this agent
 *   'errored' — claim succeeded but a downstream step failed unexpectedly
 *               (the row is left in a terminal-failed state where possible)
 */
export async function runOneClaimTick(opts: {
  agentId?: string;
  dispatchHandler?: DispatchHandler;
  /**
   * Best-effort hook fired AFTER `claimed → dispatched` succeeds (V2-005f-T_dcf10).
   * Used to wake the status subscriber for printer-target jobs. Errors are
   * logged and swallowed — the dispatch lifecycle continues regardless.
   */
  onJobDispatched?: OnJobDispatched;
  now?: Date;
  dbUrl?: string;
} = {}): Promise<'ran' | 'idle' | 'errored'> {
  const agentId = opts.agentId ?? (await getCentralWorkerAgentId(opts.dbUrl));
  const handler = opts.dispatchHandler ?? defaultDispatchHandler(opts.dbUrl);

  const candidate = await findClaimableCandidate(agentId, opts.dbUrl);
  if (!candidate) return 'idle';

  // Atomic claim. Race losers (another tick already flipped the row) bail
  // out; the next tick will pick a different candidate.
  const claimResult = await markClaimed(
    { jobId: candidate.id, agentId },
    { dbUrl: opts.dbUrl, now: opts.now },
  );
  if (!claimResult.ok) {
    // Race lost or job already moved out of claimable — caller treats as idle.
    return 'idle';
  }

  const log = logger.child({
    jobId: candidate.id,
    targetKind: candidate.targetKind,
    targetId: candidate.targetId,
  });

  // claimed → dispatched. If this fails, the row is stuck in 'claimed' and
  // stale-recovery will eventually rescue it. We still return 'errored' so
  // the caller backs off.
  const dispatchTransition = await markDispatched(
    { jobId: candidate.id },
    { dbUrl: opts.dbUrl, now: opts.now },
  );
  if (!dispatchTransition.ok) {
    log.error(
      { reason: dispatchTransition.reason },
      'forge-claim: failed to mark dispatched after successful claim',
    );
    return 'errored';
  }

  // V2-005f-T_dcf10: notify the status worker that this printer has a fresh
  // dispatched job, so it can lazy-start the per-printer subscriber. Only
  // applies to printer-target jobs; slicer-target jobs have no live status
  // feed. Best-effort: errors are logged and swallowed so the dispatch
  // continues regardless.
  if (opts.onJobDispatched && candidate.targetKind === 'printer') {
    try {
      await opts.onJobDispatched({
        dispatchJobId: candidate.id,
        printerId: candidate.targetId,
      });
    } catch (err) {
      log.warn(
        { err },
        'forge-claim: onJobDispatched hook threw — continuing dispatch',
      );
    }
  }

  // Run the dispatch handler.
  let outcome: DispatchHandlerResult;
  try {
    outcome = await handler({
      jobId: candidate.id,
      targetKind: candidate.targetKind,
      targetId: candidate.targetId,
      lootId: candidate.lootId,
      ownerId: candidate.ownerId,
    });
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'forge-claim: dispatch handler threw');
    const failResult = await markFailed(
      { jobId: candidate.id, reason: 'unknown', details },
      { dbUrl: opts.dbUrl, now: opts.now },
    );
    if (!failResult.ok) {
      log.warn(
        { reason: failResult.reason },
        'forge-claim: markFailed (post-throw) returned not-ok',
      );
    }
    return 'errored';
  }

  if (outcome.ok) {
    // V2-005d-a: leave job in 'dispatched' on successful upload.
    // V2-005f closes dispatched→completed via real printer status events
    // (Moonraker WebSocket / Bambu MQTT / SDCP events).
    // "we sent the file" ≠ "the print finished" — keep them distinct.
    return 'ran';
  }

  // Handler reported failure.
  const failResult = await markFailed(
    {
      jobId: candidate.id,
      reason: outcome.reason,
      details: outcome.details,
    },
    { dbUrl: opts.dbUrl, now: opts.now },
  );
  if (!failResult.ok) {
    log.error(
      { reason: failResult.reason },
      'forge-claim: markFailed (handler-reported) returned not-ok',
    );
    return 'errored';
  }
  return 'ran';
}

// ---------------------------------------------------------------------------
// resetStaleClaimedJobs
// ---------------------------------------------------------------------------

/**
 * Reset rows stuck in `status='claimed'` longer than `claimTimeoutMs` for
 * the given agent. Called once at startup. Returns the number of rows
 * reset.
 *
 * Implementation note: T3 ships `unclaimStaleJob(jobId, agentId, timeout)`
 * which atomically resets a single row. We SELECT candidates first (the
 * cheap query is `claim_marker = ? AND status = 'claimed'`), then call
 * unclaimStaleJob per row. The unclaim is idempotent — if the cutoff
 * predicate fails (the row was just claimed), the call is a no-op.
 */
export async function resetStaleClaimedJobs(
  opts: {
    agentId?: string;
    claimTimeoutMs?: number;
    now?: Date;
    dbUrl?: string;
  } = {},
): Promise<number> {
  const agentId = opts.agentId ?? (await getCentralWorkerAgentId(opts.dbUrl));
  const claimTimeoutMs = opts.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - claimTimeoutMs);

  const db = getServerDb(opts.dbUrl);
  const stale = await db
    .select({ id: schema.dispatchJobs.id })
    .from(schema.dispatchJobs)
    .where(
      and(
        eq(schema.dispatchJobs.status, 'claimed'),
        eq(schema.dispatchJobs.claimMarker, agentId),
        isNotNull(schema.dispatchJobs.claimedAt),
        lt(schema.dispatchJobs.claimedAt, cutoff),
      ),
    );

  if (stale.length === 0) return 0;

  let reset = 0;
  for (const row of stale) {
    const result = await unclaimStaleJob(
      { jobId: row.id, agentId, claimTimeoutMs },
      { dbUrl: opts.dbUrl, now },
    );
    if (result.ok) reset += 1;
  }

  if (reset > 0) {
    logger.warn(
      { count: reset, ids: stale.slice(0, 10).map((r) => r.id) },
      'forge-claim: reset stale claimed jobs to claimable',
    );
  }
  return reset;
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

/**
 * Start the forge claim worker pool. Idempotent — second call is a no-op
 * while the first is still running. Resolves when the pool exits (after
 * the AbortSignal fires + every loop drains its current sleep).
 *
 * Behaviour:
 *   1. Resolve the central_worker agent id (throws if bootstrap missed).
 *   2. Reset stale claimed rows (best-effort; logged but non-fatal).
 *   3. Spawn `concurrency` parallel claim loops sharing one AbortSignal.
 */
export async function startForgeClaimWorker(opts: {
  signal?: AbortSignal;
  concurrency?: number;
  dispatchHandler?: DispatchHandler;
  /**
   * Hook fired after `claimed → dispatched` succeeds. Wired in
   * instrumentation.ts to `statusWorker.notifyDispatched` (V2-005f-T_dcf10).
   */
  onJobDispatched?: OnJobDispatched;
  claimTimeoutMs?: number;
  dbUrl?: string;
} = {}): Promise<void> {
  if (claimAbort && !opts.signal) return;
  if (!opts.signal) {
    claimAbort = new AbortController();
  }
  const signal = opts.signal ?? claimAbort!.signal;

  const concurrency = clampConcurrency(
    opts.concurrency ??
      Number(process.env.WORKER_FORGE_CLAIM_CONCURRENCY ?? DEFAULT_CONCURRENCY),
  );
  const claimTimeoutMs =
    opts.claimTimeoutMs ??
    Number(process.env.WORKER_FORGE_CLAIM_TIMEOUT_MS ?? DEFAULT_CLAIM_TIMEOUT_MS);
  const handler = opts.dispatchHandler ?? defaultDispatchHandler(opts.dbUrl);

  // Resolve the agent id once at startup so per-tick lookups are cheap.
  let agentId: string;
  try {
    agentId = await getCentralWorkerAgentId(opts.dbUrl);
  } catch (err) {
    logger.error(
      { err },
      'forge-claim: cannot start — central_worker agent missing',
    );
    throw err;
  }

  // Stale recovery (best-effort, non-fatal).
  try {
    const reset = await resetStaleClaimedJobs({
      agentId,
      claimTimeoutMs,
      dbUrl: opts.dbUrl,
    });
    if (reset > 0) {
      logger.info(
        { count: reset },
        'forge-claim: reset stale claimed rows on startup',
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'forge-claim: stale-row recovery failed (non-fatal)',
    );
  }

  logger.info(
    { concurrency, claimTimeoutMs, agentId },
    'forge-claim: started',
  );

  const loops = Array.from({ length: concurrency }, () =>
    runClaimLoop({
      signal,
      agentId,
      dispatchHandler: handler,
      onJobDispatched: opts.onJobDispatched,
      dbUrl: opts.dbUrl,
    }),
  );
  await Promise.all(loops);
}

export function stopForgeClaimWorker(): void {
  claimAbort?.abort();
  claimAbort = null;
}

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 32) return 32;
  return Math.floor(n);
}

async function runClaimLoop(args: {
  signal: AbortSignal;
  agentId: string;
  dispatchHandler: DispatchHandler;
  onJobDispatched?: OnJobDispatched;
  dbUrl?: string;
}): Promise<void> {
  let backoffMs = 0;

  while (!args.signal.aborted) {
    let result: 'ran' | 'idle' | 'errored';
    try {
      result = await runOneClaimTick({
        agentId: args.agentId,
        dispatchHandler: args.dispatchHandler,
        onJobDispatched: args.onJobDispatched,
        dbUrl: args.dbUrl,
      });
    } catch (err) {
      logger.error({ err }, 'forge-claim: tick threw — backing off');
      result = 'errored';
    }

    if (result === 'errored') {
      backoffMs =
        backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    } else if (result === 'ran') {
      // Successful run — reset backoff so we eagerly poll for more work.
      backoffMs = 0;
    }
    // 'idle' leaves backoff at 0 too — short polite poll.

    const jitter = Math.floor(Math.random() * (POLL_JITTER_MS * 2)) - POLL_JITTER_MS;
    const waitMs = backoffMs > 0 ? backoffMs : Math.max(100, POLL_BASE_MS + jitter);

    try {
      await sleep(waitMs, args.signal);
    } catch {
      // Signal aborted mid-sleep — loop condition will exit on the next pass.
    }
  }
}

