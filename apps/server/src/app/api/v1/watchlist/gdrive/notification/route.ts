/**
 * Google Drive push notification webhook — V2-004b-T1.
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
 * Architectural decisions:
 *
 *   - Synchronous response REQUIRED. Google expects an HTTP 200 within
 *     ~30s; slow handlers cause retries and eventually disable the
 *     channel. T1 returns 200 IMMEDIATELY after the lookup; T4 will defer
 *     the watchlist_job enqueue to a background path so the response
 *     stays fast.
 *
 *   - Constant-time token compare via `crypto.timingSafeEqual`, mirroring
 *     the V2-003-T9 OAuth-state comparison in source-auth/_shared.ts.
 *
 *   - Bots hitting the URL with random data get 401. Deployment ops
 *     SHOULD also IP-allowlist Google's published push IPs at the proxy
 *     layer if available.
 *
 * Scope:
 *   T1 (this file) — validate token, log the event, return 200.
 *   T4            — dispatch the actual watchlist_job enqueue.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { logger } from '@/logger';

import { getGdriveWatchChannelByChannelId } from '@/watchlist/gdrive-channels';

export async function POST(req: NextRequest): Promise<Response> {
  const channelId = req.headers.get('x-goog-channel-id');
  const channelToken = req.headers.get('x-goog-channel-token');
  const resourceState = req.headers.get('x-goog-resource-state');
  const resourceId = req.headers.get('x-goog-resource-id');
  const messageNumber = req.headers.get('x-goog-message-number');

  // ── Header presence ─────────────────────────────────────────────────────
  if (!channelId || !channelToken) {
    return NextResponse.json(
      { error: 'missing-channel-headers' },
      { status: 401 },
    );
  }

  // ── Channel lookup ──────────────────────────────────────────────────────
  const channel = await getGdriveWatchChannelByChannelId(channelId);
  if (!channel) {
    logger.warn({ channelId }, 'gdrive-push: unknown channel id');
    return NextResponse.json({ error: 'unknown-channel' }, { status: 401 });
  }

  // ── Constant-time token compare (matches V2-003-T9 pattern) ─────────────
  // crypto.timingSafeEqual REQUIRES equal-length buffers; reject on length
  // mismatch BEFORE the compare so we never throw. The early exit is
  // independent of byte content so it does not introduce a content-timing
  // leak — the only thing it leaks is "wrong length", which is acceptable
  // for tokens of fixed shape.
  const a = Buffer.from(channel.token, 'utf8');
  const b = Buffer.from(channelToken, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logger.warn({ channelId }, 'gdrive-push: token mismatch');
    return NextResponse.json({ error: 'invalid-token' }, { status: 401 });
  }

  // ── 'sync' confirmation ─────────────────────────────────────────────────
  // Google sends `X-Goog-Resource-State: sync` exactly once, immediately
  // after channel registration succeeds. It carries no change payload and
  // requires no action — just acknowledge with 200.
  if (resourceState === 'sync') {
    logger.info(
      { channelId, subscriptionId: channel.subscriptionId },
      'gdrive-push: sync (registration confirmed)',
    );
    return new NextResponse(null, { status: 200 });
  }

  // ── Change notification ─────────────────────────────────────────────────
  // T4 will dispatch a watchlist_job enqueue here. T1 just logs the event
  // so deployment ops can confirm wiring before the worker side lands.
  logger.info(
    {
      channelId,
      subscriptionId: channel.subscriptionId,
      resourceState,
      resourceId,
      messageNumber,
    },
    'gdrive-push: change notification received (handler not yet wired — T4)',
  );

  return new NextResponse(null, { status: 200 });
}
