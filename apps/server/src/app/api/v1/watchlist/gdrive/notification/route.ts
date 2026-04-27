/**
 * Google Drive push notification webhook — V2-004b-T1 + T4.
 *
 * Auth model: PUBLIC URL. Authentication is via channel-id + token lookup,
 * NOT session/API-key. Google does not authenticate to us; we authenticate
 * Google's pushes via the per-channel `token` we provided at registration
 * (`changes.watch` body). The token is echoed back on every push via
 * `X-Goog-Channel-Token`.
 *
 * Headers Google sends (per
 * https://developers.google.com/workspace/drive/api/guides/push):
 *
 *   X-Goog-Channel-ID         — channel id we generated at registration
 *   X-Goog-Channel-Token      — shared secret we provided
 *   X-Goog-Channel-Expiration — channel TTL (informational; we trust the DB)
 *   X-Goog-Resource-State     — 'sync' (just-registered confirmation)
 *                                | 'change' | 'add' | 'remove'
 *                                | 'update' | 'trash' | 'untrash'
 *   X-Goog-Resource-ID        — Google's id for the watched resource
 *   X-Goog-Message-Number     — sequence number per channel
 *
 * This route is a thin shim. All business logic lives in
 * `@/watchlist/gdrive-push-handler` so it can be unit-tested without
 * spinning up Next.js. T1 shipped the lookup + token-compare + sync ack
 * paths; T4 adds change-event enqueue + message-number dedup + paused-
 * subscription drop.
 *
 * Synchronous response REQUIRED. Google expects an HTTP 200 within ~30s;
 * slow handlers cause retries and eventually disable the channel. The
 * handler is a single sync better-sqlite3 transaction (lookup + INSERT +
 * UPDATE), well under that ceiling on any sensible disk.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { handleGdrivePushNotification } from '@/watchlist/gdrive-push-handler';

export async function POST(req: NextRequest): Promise<Response> {
  const channelId = req.headers.get('x-goog-channel-id');
  const channelToken = req.headers.get('x-goog-channel-token');
  const resourceState = req.headers.get('x-goog-resource-state');
  const resourceId = req.headers.get('x-goog-resource-id');
  const messageNumberRaw = req.headers.get('x-goog-message-number');

  // ── Header presence ─────────────────────────────────────────────────────
  // Empty strings count as missing — they indicate a malformed push, not
  // a value the channel-token compare should attempt.
  if (!channelId || !channelToken) {
    return NextResponse.json(
      { error: 'missing-channel-headers' },
      { status: 401 },
    );
  }

  // Google omits resource-state on no event Google has documented, but
  // defensive: treat absent as the unknown-state path inside the handler.
  const safeResourceState = resourceState ?? '';

  // X-Goog-Message-Number is a numeric string per Google's docs. NaN /
  // missing → treat as null and fall through to the no-dedup path. We do
  // NOT 401 on parse failure — replays without numbers should still
  // gracefully bypass dedup (and the in-flight check will catch most
  // double-enqueues anyway).
  let messageNumber: number | null = null;
  if (messageNumberRaw) {
    const parsed = Number.parseInt(messageNumberRaw, 10);
    if (Number.isFinite(parsed)) messageNumber = parsed;
  }

  const result = await handleGdrivePushNotification({
    channelId,
    channelToken,
    resourceState: safeResourceState,
    resourceId,
    messageNumber,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.httpStatus });
  }

  return new NextResponse(null, { status: 200 });
}
