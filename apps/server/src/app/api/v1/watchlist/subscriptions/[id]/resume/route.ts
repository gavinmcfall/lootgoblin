/**
 * POST /api/v1/watchlist/subscriptions/:id/resume — V2-004-T9
 *
 * Resume a paused subscription. Body: `{ catch_up?: boolean }`.
 *   - `catch_up=false` (default) — leaves `last_fired_at` as-is so cadence
 *     resumes naturally from where it was paused.
 *   - `catch_up=true` — sets `last_fired_at = NULL` so the next scheduler
 *     tick fires the subscription immediately, regardless of cadence.
 *
 * Returns 204. Owner-only (same ACL as the parent route).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { loadSubscriptionForActor, ResumeBodySchema } from '../../_shared';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  // Empty body is allowed — accept both no-body and `{}`.
  let raw: unknown = undefined;
  const text = await req.text();
  if (text.length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: 'invalid-body', reason: 'JSON parse failed' },
        { status: 400 },
      );
    }
  }
  const parsed = ResumeBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const catchUp = parsed.data?.catch_up === true;

  const loaded = await loadSubscriptionForActor(req, id);
  if (!loaded.ok) return loaded.response;

  const db = getServerDb();
  const patch: Partial<typeof schema.watchlistSubscriptions.$inferInsert> = {
    active: 1,
    updatedAt: new Date(),
  };
  if (catchUp) patch.lastFiredAt = null;

  await db
    .update(schema.watchlistSubscriptions)
    .set(patch)
    .where(eq(schema.watchlistSubscriptions.id, id));

  return new Response(null, { status: 204 });
}
