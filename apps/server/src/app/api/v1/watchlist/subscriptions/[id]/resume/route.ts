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
import { and, eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import { loadSubscriptionForActor, ResumeBodySchema } from '../../_shared';
import {
  registerGdriveChannel,
  unregisterGdriveChannel,
} from '@/watchlist/gdrive-channels-register';

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
  const { actor, row: subRow } = loaded;

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

  // V2-004b-T2: re-register a fresh GDrive push channel if the subscription
  // had one expired by an earlier pause. We delete the stale row first
  // (best-effort channels/stop) then register fresh — matches the "channel
  // re-registration is part of the resume flow" decision.
  if (
    subRow.kind === 'folder_watch' &&
    subRow.sourceAdapterId === 'google-drive'
  ) {
    try {
      const expiredRows = await db
        .select({
          channelId: schema.gdriveWatchChannels.channelId,
        })
        .from(schema.gdriveWatchChannels)
        .where(
          and(
            eq(schema.gdriveWatchChannels.subscriptionId, id),
            eq(schema.gdriveWatchChannels.status, 'expired'),
          ),
        );
      if (expiredRows.length > 0) {
        for (const ch of expiredRows) {
          // Best-effort: drop the stale row (and try to call channels/stop
          // even though Google may have already timed it out).
          await unregisterGdriveChannel({
            channelId: ch.channelId,
            subscriptionId: id,
          });
        }
        const publicUrl =
          process.env.INSTANCE_PUBLIC_URL ?? process.env.BETTER_AUTH_URL;
        if (publicUrl) {
          const webhookAddress = `${publicUrl.replace(/\/+$/, '')}/api/v1/watchlist/gdrive/notification`;
          const result = await registerGdriveChannel({
            subscriptionId: id,
            ownerId: actor.id,
            webhookAddress,
          });
          if (!result.ok) {
            logger.warn(
              { subscriptionId: id, reason: result.reason },
              'gdrive-channel-register: resume re-registration failed; falling back to polling',
            );
          }
        } else {
          logger.info(
            { subscriptionId: id },
            'gdrive-channel-register: resume — INSTANCE_PUBLIC_URL not set; polling-only',
          );
        }
      }
    } catch (err) {
      logger.warn(
        { subscriptionId: id, err },
        'gdrive-channel-register: resume re-registration threw (non-fatal)',
      );
    }
  }

  return new Response(null, { status: 204 });
}
