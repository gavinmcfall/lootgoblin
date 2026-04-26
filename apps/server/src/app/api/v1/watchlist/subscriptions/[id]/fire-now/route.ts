/**
 * POST /api/v1/watchlist/subscriptions/:id/fire-now — V2-004-T9
 *
 * Manually enqueue a `watchlist_jobs` row for this subscription, bypassing
 * cadence. Used by the "test my subscription" UX so users can verify their
 * adapter config without waiting for the scheduler tick.
 *
 * Behaviour
 * ─────────
 *   - 401 if no auth.
 *   - 404 if not owned (id leak protection).
 *   - 409 if there's already an in-flight `watchlist_job` for this
 *     subscription (status ∈ queued/claimed/running) — returns the existing
 *     job id so the UI can poll it.
 *   - 201 otherwise — INSERT a row with status='queued'. The watchlist
 *     scheduler/worker picks it up on the next tick.
 *
 * Important: this route does NOT update the subscription's `last_fired_at`.
 * That column is the scheduler's bookkeeping for cadence — fire-now is
 * a separate, user-initiated firing. The worker stamps `started_at` and
 * `completed_at` on the watchlist_job row as usual.
 *
 * Owner-only ACL via the shared loader (see `../../_shared.ts`).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

import { getServerDb, schema } from '@/db/client';
import { findInFlightJob, loadSubscriptionForActor } from '../../_shared';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const loaded = await loadSubscriptionForActor(req, id);
  if (!loaded.ok) return loaded.response;
  const { row } = loaded;

  // Reject fire-now on a paused subscription — the worker would skip the
  // job because `active=0`. Surface the bad state to the caller.
  if (row.active !== 1) {
    return NextResponse.json(
      {
        error: 'subscription-paused',
        reason: 'cannot fire a paused subscription — resume it first',
      },
      { status: 409 },
    );
  }

  const inFlight = await findInFlightJob(id);
  if (inFlight) {
    return NextResponse.json(
      {
        error: 'job-in-flight',
        reason: 'an existing watchlist_job is still running for this subscription',
        jobId: inFlight.id,
        status: inFlight.status,
      },
      { status: 409 },
    );
  }

  const db = getServerDb();
  const jobId = randomUUID();
  const now = new Date();
  await db.insert(schema.watchlistJobs).values({
    id: jobId,
    subscriptionId: id,
    status: 'queued',
    itemsDiscovered: 0,
    itemsEnqueued: 0,
    createdAt: now,
  });

  return NextResponse.json(
    {
      job: {
        id: jobId,
        subscriptionId: id,
        status: 'queued',
        itemsDiscovered: 0,
        itemsEnqueued: 0,
        createdAt: now.toISOString(),
      },
    },
    { status: 201 },
  );
}
