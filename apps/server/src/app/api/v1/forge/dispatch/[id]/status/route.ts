// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * GET /api/v1/forge/dispatch/:id/status — V2-005f-T_dcf12
 *
 * Returns the dispatch_job's latest cached state (status + progress_pct +
 * last_status_at) plus the latest 50 dispatch_status_events ordered by
 * occurred_at DESC, and all active dispatch_warnings ordered newest-first.
 *
 * Owner-or-admin ACL. Cross-owner → 404 (not 403) to avoid leaking the
 * existence of another user's dispatch — same policy as the V2-005a-T5
 * `/events` route.
 *
 * Distinct from `/events`:
 *   - `/events` returns the dispatch_jobs' lifecycle log derived from row
 *     timestamps (created/claimed/dispatched/completed). Coarse-grained.
 *   - `/status` returns the fine-grained protocol-level status feed
 *     (progress, layer, remaining minutes, etc.) accumulated by the
 *     V2-005f status subscribers.
 *
 * V2-005f-CF-5a T_a7: the `warnings` array is sourced from `dispatch_warnings`
 * using the `idx_dispatch_warnings_job` index (dispatch_job_id + last_seen_at).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { desc, eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';

import { errorResponse, requireAuth } from '../../../_shared';

const STATUS_EVENT_LIMIT = 50;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  if (typeof id !== 'string' || id.length === 0) {
    return errorResponse('invalid-path', 'missing dispatch id', 400);
  }

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return errorResponse('not-found', 'dispatch-not-found', 404);
  }
  if (actor.role !== 'admin' && row.ownerId !== actor.id) {
    return errorResponse('not-found', 'dispatch-not-found', 404);
  }

  // Latest 50 events for this dispatch, newest first.
  const eventRows = await db
    .select()
    .from(schema.dispatchStatusEvents)
    .where(eq(schema.dispatchStatusEvents.dispatchJobId, id))
    .orderBy(desc(schema.dispatchStatusEvents.occurredAt))
    .limit(STATUS_EVENT_LIMIT);

  const events = eventRows.map((e) => ({
    id: e.id,
    event_kind: e.eventKind,
    event_data: parseEventData(e.eventData),
    source_protocol: e.sourceProtocol,
    occurred_at: e.occurredAt.getTime(),
    ingested_at: e.ingestedAt.getTime(),
  }));

  // All active warnings for this dispatch, newest-first (idx_dispatch_warnings_job).
  // `protocol` is included so the UI can surface "warning from Bambu vs SDCP"; numeric
  // error-code spaces overlap across protocols so the label matters for disambiguation.
  // If this turns out to be unnecessary exposure, remove via a future cleanup pass.
  const warningRows = await db
    .select({
      warning_id: schema.dispatchWarnings.id,
      error_code: schema.dispatchWarnings.errorCode,
      protocol: schema.dispatchWarnings.protocol,
      severity: schema.dispatchWarnings.severity,
      message: schema.dispatchWarnings.message,
      first_seen_at: schema.dispatchWarnings.firstSeenAt,
      last_seen_at: schema.dispatchWarnings.lastSeenAt,
      count: schema.dispatchWarnings.count,
    })
    .from(schema.dispatchWarnings)
    .where(eq(schema.dispatchWarnings.dispatchJobId, id))
    .orderBy(desc(schema.dispatchWarnings.lastSeenAt));

  const warnings = warningRows.map((w) => ({
    warning_id: w.warning_id,
    error_code: w.error_code,
    protocol: w.protocol,
    severity: w.severity,
    message: w.message ?? null,
    // timestamp_ms columns arrive as Date objects from Drizzle; serialize to
    // epoch millis matching the existing occurred_at / ingested_at convention.
    first_seen_at: (w.first_seen_at as Date).getTime(),
    last_seen_at: (w.last_seen_at as Date).getTime(),
    count: w.count,
  }));

  return NextResponse.json({
    dispatch_job_id: row.id,
    status: row.status,
    progress_pct: row.progressPct ?? null,
    last_status_at: row.lastStatusAt ? row.lastStatusAt.getTime() : null,
    events,
    warnings,
  });
}

/**
 * The status sink stringifies a structured event-data object before INSERT.
 * Re-parse it into a plain JSON object so consumers don't need to JSON.parse
 * twice. Tolerate malformed rows (defensive — should not occur in practice)
 * by returning the raw string under `_raw`.
 */
function parseEventData(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}
