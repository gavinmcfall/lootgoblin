// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * POST /api/v1/dispatch/status — V2-006a-T8
 *
 * Courier status-report endpoint. Drives the dispatch lifecycle from out-of-band
 * Courier reports — the same transitions the in-process forge-status-worker
 * performs for LAN printers.
 *
 * Auth: Courier API key in `x-api-key` header (courier_pairing scope).
 *
 * Body (discriminated on `phase`):
 *
 *   { phase:'dispatched', job_id, remote_filename? }
 *     → markDispatched({ jobId }) — file reached the printer.
 *
 *   { phase:'failed', job_id, reason, details? }
 *     → mapAdapterReasonToSchema(reason) + markFailed({ jobId, reason, details })
 *
 *   { phase:'status-event', job_id, event }
 *     → persistStatusEvent via the existing status-event-handler dedup path.
 *
 *   { phase:'completed', job_id, materials_used? }
 *     → markCompleted({ jobId }) + emitConsumptionForCompletion (Phase B).
 *       If materials_used supplied, persist to dispatch_jobs.materials_used
 *       and emit 'measured' provenance; else fall back to cached Phase-A estimate.
 *
 * Ownership guard: every phase checks `dispatch_jobs.claim_marker === agentId`.
 * A non-existent or unowned job → 403 (no existence leak).
 *
 * Idempotency: terminal-state transitions that hit `wrong-state` with
 * currentState already at the target → 200 { ok:true, noop:true }.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import {
  authenticateCourier,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/courier-auth';
import { getServerDb, schema } from '@/db/client';
import {
  markDispatched,
  markFailed,
  markCompleted,
} from '@/forge/dispatch-state';
import { mapAdapterReasonToSchema } from '@/forge/dispatch/failure-reason-map';
import {
  persistStatusEvent,
  derivePrinterProtocol,
} from '@/forge/status/status-event-handler';
import { emitConsumptionForCompletion } from '@/forge/status/consumption-emitter';
import type { MaterialsUsed } from '@/db/schema.forge';
import type { MeasuredConsumptionSlot, StatusEvent } from '@/forge/status/types';
import { logger } from '@/logger';

// ---------------------------------------------------------------------------
// Zod schemas for each phase
// ---------------------------------------------------------------------------

const ForgeAdapterFailureReasonSchema = z.enum([
  'unreachable',
  'auth-failed',
  'rejected',
  'no-credentials',
  'unsupported-protocol',
  'timeout',
  'unknown',
]);

const MaterialsUsedInputSchema = z.array(
  z.object({
    slot_index: z.number().int().nonnegative(),
    material_id: z.string(),
    measured_grams: z.number().nonnegative(),
  }),
);

/** Zod schema for the StatusEvent-shaped body the Courier reports. */
const StatusEventInputSchema = z.object({
  kind: z.string(),
  remote_job_ref: z.string().default(''),
  progress_pct: z.number().optional(),
  layer_num: z.number().optional(),
  total_layers: z.number().optional(),
  remaining_min: z.number().optional(),
  measured_consumption: z
    .array(
      z.object({
        slot_index: z.number().int().nonnegative(),
        grams: z.number().nonnegative(),
        volume_ml: z.number().optional(),
        remain_percent: z.number().optional(),
      }),
    )
    .optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  severity: z.enum(['info', 'warning', 'error']).optional(),
  raw_payload: z.unknown().optional(),
  occurred_at: z.string().optional(),
});

const DispatchedBodySchema = z.object({
  phase: z.literal('dispatched'),
  job_id: z.string().min(1),
  remote_filename: z.string().optional(),
});

const FailedBodySchema = z.object({
  phase: z.literal('failed'),
  job_id: z.string().min(1),
  reason: ForgeAdapterFailureReasonSchema,
  details: z.string().optional(),
});

const StatusEventBodySchema = z.object({
  phase: z.literal('status-event'),
  job_id: z.string().min(1),
  event: StatusEventInputSchema,
});

const CompletedBodySchema = z.object({
  phase: z.literal('completed'),
  job_id: z.string().min(1),
  materials_used: MaterialsUsedInputSchema.optional(),
});

const BodySchema = z.discriminatedUnion('phase', [
  DispatchedBodySchema,
  FailedBodySchema,
  StatusEventBodySchema,
  CompletedBodySchema,
]);

// ---------------------------------------------------------------------------
// Ownership guard
// ---------------------------------------------------------------------------

interface JobRow {
  claimMarker: string | null;
  status: string;
  lootId: string;
  targetKind: string;
  targetId: string;
}

/**
 * Load the dispatch_jobs row and verify the agent holds the claim.
 * Returns the row on success, or null when the guard should reject.
 * Callers respond with 403 on null (no existence leak).
 */
async function loadAndGuardJob(
  jobId: string,
  agentId: string,
  dbUrl?: string,
): Promise<JobRow | null> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({
      claimMarker: schema.dispatchJobs.claimMarker,
      status: schema.dispatchJobs.status,
      lootId: schema.dispatchJobs.lootId,
      targetKind: schema.dispatchJobs.targetKind,
      targetId: schema.dispatchJobs.targetId,
    })
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, jobId))
    .limit(1);

  const row = rows[0];
  if (!row || row.claimMarker !== agentId) {
    return null;
  }
  return row;
}

const FORBIDDEN = NextResponse.json(
  { error: 'forbidden', reason: 'not-claimed-by-agent' },
  { status: 403 },
);

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // 1. Authenticate — identity from courier_pairing key only.
  const courier = await authenticateCourier(req);
  if (!courier || courier === INVALID_API_KEY) {
    return unauthenticatedResponse(courier as null | typeof INVALID_API_KEY);
  }
  const { agentId } = courier;

  // 2. Parse body.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad-request', reason: 'invalid-json' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad-request', reason: 'validation-failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // ---------------------------------------------------------------------------
  // Phase: dispatched
  // ---------------------------------------------------------------------------
  if (body.phase === 'dispatched') {
    const job = await loadAndGuardJob(body.job_id, agentId);
    if (!job) return FORBIDDEN;

    const result = await markDispatched({ jobId: body.job_id });
    if (!result.ok) {
      // Idempotency: already dispatched → noop success.
      const alreadyTarget =
        'currentState' in result && result.currentState === 'dispatched';
      if (alreadyTarget || ('currentState' in result && result.currentState === 'completed')) {
        return NextResponse.json({ ok: true, noop: true }, { status: 200 });
      }
      return NextResponse.json(
        { error: 'transition-failed', reason: result.reason, current_state: 'currentState' in result ? result.currentState : undefined },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Phase: failed
  // ---------------------------------------------------------------------------
  if (body.phase === 'failed') {
    const job = await loadAndGuardJob(body.job_id, agentId);
    if (!job) return FORBIDDEN;

    const schemaReason = mapAdapterReasonToSchema(body.reason);
    const result = await markFailed({ jobId: body.job_id, reason: schemaReason, details: body.details });
    if (!result.ok) {
      // Idempotency: already failed or completed → noop.
      const currentState = 'currentState' in result ? result.currentState : undefined;
      if (currentState === 'failed' || currentState === 'completed') {
        return NextResponse.json({ ok: true, noop: true }, { status: 200 });
      }
      return NextResponse.json(
        { error: 'transition-failed', reason: result.reason, current_state: currentState },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Phase: status-event
  // ---------------------------------------------------------------------------
  if (body.phase === 'status-event') {
    const job = await loadAndGuardJob(body.job_id, agentId);
    if (!job) return FORBIDDEN;

    // status-event only makes sense for printer targets where we have a printerKind.
    if (job.targetKind !== 'printer') {
      return NextResponse.json(
        { error: 'bad-request', reason: 'status-events-only-valid-for-printer-targets' },
        { status: 400 },
      );
    }

    const db = getServerDb();
    const printerRows = await db
      .select({ kind: schema.printers.kind })
      .from(schema.printers)
      .where(eq(schema.printers.id, job.targetId))
      .limit(1);
    const printerKind = printerRows[0]?.kind;

    if (!printerKind || !derivePrinterProtocol(printerKind)) {
      // Printer row gone or unknown kind — cannot derive source_protocol.
      logger.warn(
        { jobId: body.job_id, agentId, printerKind },
        'dispatch-status: cannot derive source_protocol — dropping status-event',
      );
      return NextResponse.json(
        { error: 'bad-request', reason: 'unknown-printer-protocol' },
        { status: 400 },
      );
    }

    const rawEvent = body.event;
    const occurredAt = rawEvent.occurred_at
      ? new Date(rawEvent.occurred_at)
      : new Date();

    const statusEvent: StatusEvent = {
      kind: rawEvent.kind as Parameters<typeof persistStatusEvent>[0]['event']['kind'],
      remoteJobRef: rawEvent.remote_job_ref,
      progressPct: rawEvent.progress_pct,
      layerNum: rawEvent.layer_num,
      totalLayers: rawEvent.total_layers,
      remainingMin: rawEvent.remaining_min,
      measuredConsumption: rawEvent.measured_consumption as MeasuredConsumptionSlot[] | undefined,
      errorCode: rawEvent.error_code,
      errorMessage: rawEvent.error_message,
      severity: rawEvent.severity,
      rawPayload: rawEvent.raw_payload ?? null,
      occurredAt,
    };

    try {
      await persistStatusEvent({
        printerId: job.targetId,
        dispatchJobId: body.job_id,
        printerKind,
        event: statusEvent,
      });
    } catch (err) {
      logger.error(
        { err, jobId: body.job_id, agentId },
        'dispatch-status: persistStatusEvent threw',
      );
      return NextResponse.json(
        { error: 'internal-error', reason: 'persist-failed' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Phase: completed
  // ---------------------------------------------------------------------------
  // body.phase === 'completed'
  {
    const job = await loadAndGuardJob(body.job_id, agentId);
    if (!job) return FORBIDDEN;

    // If Courier provides measured materials_used, persist them before transitioning.
    if (body.materials_used && body.materials_used.length > 0) {
      const materialsUsed: MaterialsUsed = body.materials_used.map((m) => ({
        slot_index: m.slot_index,
        material_id: m.material_id,
        estimated_grams: 0, // no slicer estimate for Courier-reported measured values
        measured_grams: m.measured_grams,
      }));
      (getServerDb()
        .update(schema.dispatchJobs)
        .set({ materialsUsed })
        .where(eq(schema.dispatchJobs.id, body.job_id)) as unknown as {
        run: () => unknown;
      }).run();
    }

    // Attempt the dispatched → completed transition.
    const result = await markCompleted({ jobId: body.job_id });
    if (!result.ok) {
      const currentState = 'currentState' in result ? result.currentState : undefined;
      // Idempotency: already completed → noop.
      if (currentState === 'completed') {
        return NextResponse.json({ ok: true, noop: true }, { status: 200 });
      }
      return NextResponse.json(
        { error: 'transition-failed', reason: result.reason, current_state: currentState },
        { status: 409 },
      );
    }

    // Transition won — emit Phase B consumption. Build a synthetic StatusEvent
    // so emitConsumptionForCompletion can correlate slots vs. measuredConsumption.
    //
    // If Courier provided measured materials_used, build measuredConsumption from
    // those entries (grams are already absolute — pass directly, skip remain_percent).
    // If no materials_used, pass empty measuredConsumption → emitter no-ops on
    // Phase B (Phase A estimated events are the only record — correct behaviour).
    const measuredConsumption: MeasuredConsumptionSlot[] =
      body.materials_used && body.materials_used.length > 0
        ? body.materials_used.map((m) => ({
            slot_index: m.slot_index,
            grams: m.measured_grams,
          }))
        : [];

    const completionEvent: StatusEvent = {
      kind: 'completed',
      remoteJobRef: '',
      measuredConsumption,
      rawPayload: null,
      occurredAt: new Date(),
    };

    try {
      await emitConsumptionForCompletion({
        dispatchJobId: body.job_id,
        event: completionEvent,
        provenance: 'measured',
      });
    } catch (err) {
      // Consumption failures must NOT prevent the completion response — the
      // job transitioned correctly; the ledger emission is best-effort.
      logger.error(
        { err, jobId: body.job_id },
        'dispatch-status: emitConsumptionForCompletion threw — job completed; consumption may be missing',
      );
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  }
}
