/**
 * Write-side helpers for `gdrive_watch_channels` — V2-004b-T2.
 *
 * Registers + unregisters Google Drive `changes.watch` push channels for
 * folder_watch subscriptions on the google-drive adapter.
 *
 * Architectural decisions (locked in V2-004b T2 design):
 *
 *   - Register on subscription CREATE (not lazily on first firing).
 *   - Don't BLOCK subscription creation on registration failure — the
 *     subscription still works via cadence-based polling. Push is a
 *     latency optimisation, not a correctness requirement.
 *   - Unregister on subscription DELETE via `channels/stop`. Don't block
 *     deletion on Google's response; if the channel is already expired
 *     server-side the call is a no-op.
 *   - Pause: mark `status='expired'` locally; do NOT call `channels/stop`
 *     (the refresh worker skips expired rows; Google times the channel
 *     out at the 7-day TTL anyway).
 *   - Resume: re-register if a previously-expired channel exists.
 *   - OAuth required. API-key-only credentials cannot register watch
 *     channels (Google's policy). Returns `reason: 'oauth-required'` —
 *     callers treat this as "fall back to polling, log info".
 *   - Token: 32 bytes hex via `crypto.randomBytes`. Channel id: UUID v4.
 *   - Webhook URL must be HTTPS in production. Sourced from
 *     `INSTANCE_PUBLIC_URL` env var (config schema is closed-shape; an
 *     env-var hand-off keeps this T2 self-contained — see route wiring).
 *
 * Channel TTL (7 days max) is enforced by Google; the T3 refresh worker
 * walks `expirationMs` and rolls them. T2 sets the requested expiration to
 * `now + 7 days`.
 *
 * @see https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/watch
 * @see https://developers.google.com/workspace/drive/api/reference/rest/v3/channels/stop
 */

import * as crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { decrypt, encrypt } from '@/crypto';
import { logger } from '@/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterGdriveChannelInput {
  subscriptionId: string;
  /** Owner of the subscription — kept for symmetry / future per-user creds. */
  ownerId: string;
  /** Public HTTPS URL (full path) we register with Google. */
  webhookAddress: string;
}

export type RegisterGdriveChannelResult =
  | { ok: true; channelId: string; expirationMs: number }
  | { ok: false; reason: RegisterFailureReason; details?: string };

export type RegisterFailureReason =
  | 'subscription-mismatch'
  | 'oauth-required'
  | 'invalid-webhook-address'
  | 'registration-failed';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_LEAD_MS = 60_000;
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

type GdriveOAuthBag = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  clientSecret: string;
};

// ---------------------------------------------------------------------------
// registerGdriveChannel
// ---------------------------------------------------------------------------

/**
 * Register a Google Drive `changes.watch` channel for a subscription.
 *
 * Side effects on success:
 *   - Inserts a `gdrive_watch_channels` row with status='active'.
 *
 * Returns a discriminated result; callers (the route layer) decide whether
 * the failure is silenced (warn + fall back to polling) or surfaced.
 */
export async function registerGdriveChannel(
  input: RegisterGdriveChannelInput,
  opts?: {
    dbUrl?: string;
    httpFetch?: typeof fetch;
    now?: Date;
  },
): Promise<RegisterGdriveChannelResult> {
  const db = getServerDb(opts?.dbUrl);
  const httpFetch = opts?.httpFetch ?? fetch;
  const now = opts?.now ?? new Date();

  // Validate webhook address shape early — Google rejects non-HTTPS at
  // registration time anyway, but failing fast keeps the error path cleaner.
  let parsedAddress: URL;
  try {
    parsedAddress = new URL(input.webhookAddress);
  } catch {
    return {
      ok: false,
      reason: 'invalid-webhook-address',
      details: `not a valid URL: ${input.webhookAddress}`,
    };
  }
  if (parsedAddress.protocol !== 'https:' && parsedAddress.hostname !== 'localhost') {
    return {
      ok: false,
      reason: 'invalid-webhook-address',
      details: `webhook must use https://: ${input.webhookAddress}`,
    };
  }

  // 1. Look up subscription. Validate kind + source_adapter_id.
  const subRows = await db
    .select()
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, input.subscriptionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) {
    return { ok: false, reason: 'subscription-mismatch', details: 'subscription not found' };
  }
  if (sub.kind !== 'folder_watch') {
    return {
      ok: false,
      reason: 'subscription-mismatch',
      details: `expected kind='folder_watch', got '${sub.kind}'`,
    };
  }
  if (sub.sourceAdapterId !== 'google-drive') {
    return {
      ok: false,
      reason: 'subscription-mismatch',
      details: `expected source_adapter_id='google-drive', got '${sub.sourceAdapterId}'`,
    };
  }

  // 2. Look up + decrypt credentials. OAuth required.
  const credLookup = await loadOAuthCredentials(sub.sourceAdapterId, opts?.dbUrl);
  if (!credLookup.ok) {
    return { ok: false, reason: 'oauth-required', details: credLookup.reason };
  }

  // 3. Refresh OAuth if near expiry.
  let oauth = credLookup.oauth;
  if (oauth.expiresAt - Date.now() < TOKEN_REFRESH_LEAD_MS) {
    const refreshed = await refreshOAuthToken(oauth, httpFetch);
    if (!refreshed.ok) {
      logger.warn(
        {
          subscriptionId: input.subscriptionId,
          reason: refreshed.reason,
          details: refreshed.details,
        },
        'gdrive-channel-register: OAuth refresh failed',
      );
      return { ok: false, reason: 'registration-failed', details: refreshed.details };
    }
    oauth = refreshed.oauth;
    // Persist refreshed bag — same merge pattern as watchlist-worker.
    try {
      await persistRefreshedOAuth(credLookup.credentialId, oauth, credLookup.fullBag, opts?.dbUrl);
    } catch (err) {
      logger.warn(
        { subscriptionId: input.subscriptionId, err },
        'gdrive-channel-register: failed to persist refreshed OAuth (continuing)',
      );
    }
  }

  // 4. Generate channel id + token.
  const channelId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const expirationMs = Date.now() + TTL_MS;

  // 5. Get the current changes start page token. `changes.watch` requires it
  //    as a `?pageToken=` query param.
  const startToken = await getStartPageToken(oauth.accessToken, httpFetch);
  if (!startToken.ok) {
    logger.warn(
      {
        subscriptionId: input.subscriptionId,
        status: startToken.status,
        details: startToken.details,
      },
      'gdrive-channel-register: getStartPageToken failed',
    );
    return { ok: false, reason: 'registration-failed', details: startToken.details };
  }

  // 6. POST /changes/watch?pageToken=<token>.
  const watchUrl = `${DRIVE_API_BASE}/changes/watch?pageToken=${encodeURIComponent(
    startToken.pageToken,
  )}`;
  let watchRes: Response;
  try {
    watchRes = await httpFetch(watchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        id: channelId,
        type: 'web_hook',
        address: input.webhookAddress,
        token,
        expiration: String(expirationMs),
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { subscriptionId: input.subscriptionId, err: msg },
      'gdrive-channel-register: changes.watch fetch threw',
    );
    return { ok: false, reason: 'registration-failed', details: `fetch failed: ${msg}` };
  }

  if (!watchRes.ok) {
    let body = '';
    try {
      body = await watchRes.text();
    } catch {
      /* ignore */
    }
    const redacted = redactBody(body);
    logger.warn(
      {
        subscriptionId: input.subscriptionId,
        status: watchRes.status,
        body: redacted,
      },
      'gdrive-channel-register: changes.watch returned non-2xx',
    );
    return {
      ok: false,
      reason: 'registration-failed',
      details: `HTTP ${watchRes.status}${watchRes.status === 401 || watchRes.status === 403 ? ' (auth)' : ''}`,
    };
  }

  let payload: unknown;
  try {
    payload = await watchRes.json();
  } catch (err) {
    return {
      ok: false,
      reason: 'registration-failed',
      details: `failed to parse watch response: ${(err as Error).message}`,
    };
  }
  const parsed = parseWatchResponse(payload);
  if (!parsed.ok) {
    return { ok: false, reason: 'registration-failed', details: parsed.details };
  }

  // 7. Insert the channel row.
  try {
    await db.insert(schema.gdriveWatchChannels).values({
      id: crypto.randomUUID(),
      subscriptionId: input.subscriptionId,
      channelId: parsed.channelId,
      resourceId: parsed.resourceId,
      resourceType: 'changes',
      address: input.webhookAddress,
      token,
      expirationMs: new Date(parsed.expirationMs),
      status: 'active',
      refreshedAt: now,
      createdAt: now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { subscriptionId: input.subscriptionId, err: msg },
      'gdrive-channel-register: row insert failed after successful Google watch (channel will leak until TTL)',
    );
    return { ok: false, reason: 'registration-failed', details: `db insert failed: ${msg}` };
  }

  logger.info(
    {
      subscriptionId: input.subscriptionId,
      channelId: parsed.channelId,
      expirationMs: parsed.expirationMs,
    },
    'gdrive-channel-register: channel registered',
  );

  return { ok: true, channelId: parsed.channelId, expirationMs: parsed.expirationMs };
}

// ---------------------------------------------------------------------------
// unregisterGdriveChannel
// ---------------------------------------------------------------------------

/**
 * Unregister (stop) a Google Drive watch channel and delete its row.
 *
 * Idempotent: if the local row doesn't exist, returns `{ok: true}`.
 * Tolerant: if Google rejects (channel already expired etc), the local row
 * is still deleted and we return `{ok: true}`. The CASCADE on subscription
 * delete is the fail-safe.
 */
export async function unregisterGdriveChannel(
  args: { channelId: string; subscriptionId: string },
  opts?: { dbUrl?: string; httpFetch?: typeof fetch },
): Promise<{ ok: true } | { ok: false; reason: string; details?: string }> {
  const db = getServerDb(opts?.dbUrl);
  const httpFetch = opts?.httpFetch ?? fetch;

  const rows = await db
    .select()
    .from(schema.gdriveWatchChannels)
    .where(
      and(
        eq(schema.gdriveWatchChannels.channelId, args.channelId),
        eq(schema.gdriveWatchChannels.subscriptionId, args.subscriptionId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { ok: true };
  }

  // Look up creds + refresh if needed; ignore failures (we still delete).
  const subRows = await db
    .select({ sourceAdapterId: schema.watchlistSubscriptions.sourceAdapterId })
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, args.subscriptionId))
    .limit(1);
  const sub = subRows[0];

  let oauth: GdriveOAuthBag | null = null;
  if (sub) {
    const credLookup = await loadOAuthCredentials(sub.sourceAdapterId, opts?.dbUrl);
    if (credLookup.ok) {
      oauth = credLookup.oauth;
      if (oauth.expiresAt - Date.now() < TOKEN_REFRESH_LEAD_MS) {
        const refreshed = await refreshOAuthToken(oauth, httpFetch);
        if (refreshed.ok) {
          oauth = refreshed.oauth;
        }
      }
    }
  }

  if (oauth) {
    try {
      const stopRes = await httpFetch(`${DRIVE_API_BASE.replace('/drive/v3', '')}/drive/v3/channels/stop`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ id: row.channelId, resourceId: row.resourceId }),
      });
      if (!stopRes.ok) {
        // Log + continue — Google may have already expired the channel.
        let body = '';
        try {
          body = await stopRes.text();
        } catch {
          /* ignore */
        }
        logger.warn(
          {
            channelId: row.channelId,
            subscriptionId: args.subscriptionId,
            status: stopRes.status,
            body: redactBody(body),
          },
          'gdrive-channel-register: channels/stop returned non-2xx (deleting row anyway)',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { channelId: row.channelId, subscriptionId: args.subscriptionId, err: msg },
        'gdrive-channel-register: channels/stop fetch threw (deleting row anyway)',
      );
    }
  } else {
    logger.info(
      { channelId: row.channelId, subscriptionId: args.subscriptionId },
      'gdrive-channel-register: no OAuth available for channels/stop (deleting row anyway)',
    );
  }

  try {
    await db
      .delete(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.id, row.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'db-delete-failed', details: msg };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// expireGdriveChannel
// ---------------------------------------------------------------------------

/**
 * Mark all channels for a subscription as expired (without calling Google).
 *
 * Used by the pause flow: the refresh worker (T3) skips `status='expired'`
 * rows. Google times the channel out naturally at TTL; saving the API
 * roundtrip keeps the pause path quick.
 */
export async function expireGdriveChannel(
  args: { subscriptionId: string },
  opts?: { dbUrl?: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = getServerDb(opts?.dbUrl);
  try {
    await db
      .update(schema.gdriveWatchChannels)
      .set({ status: 'expired' })
      .where(eq(schema.gdriveWatchChannels.subscriptionId, args.subscriptionId));
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}

// ---------------------------------------------------------------------------
// Helpers — credential lookup, OAuth refresh, response parsing
// ---------------------------------------------------------------------------

type CredLookupOk = {
  ok: true;
  oauth: GdriveOAuthBag;
  credentialId: string;
  fullBag: Record<string, unknown>;
};
type CredLookupErr = { ok: false; reason: string };

async function loadOAuthCredentials(
  sourceId: string,
  dbUrl: string | undefined,
): Promise<CredLookupOk | CredLookupErr> {
  const secret = process.env.LOOTGOBLIN_SECRET;
  if (!secret) return { ok: false, reason: 'LOOTGOBLIN_SECRET unavailable' };

  const db = getServerDb(dbUrl);
  const rows = await db
    .select({
      id: schema.sourceCredentials.id,
      encryptedBlob: schema.sourceCredentials.encryptedBlob,
    })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, sourceId))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'no source_credentials row' };

  let bag: Record<string, unknown>;
  try {
    const buf = Buffer.from(row.encryptedBlob as Uint8Array);
    const json = decrypt(buf.toString('utf8'), secret);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, reason: 'credential bag is not an object' };
    }
    bag = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `credential decrypt failed: ${(err as Error).message}` };
  }

  const kind = bag['kind'];
  let oauthRaw: unknown = null;
  if (kind === 'oauth') {
    oauthRaw = bag;
  } else if (kind === 'oauth+api-key') {
    oauthRaw = bag['oauth'];
  } else {
    return { ok: false, reason: `credentials kind '${String(kind)}' does not support push` };
  }

  if (!oauthRaw || typeof oauthRaw !== 'object') {
    return { ok: false, reason: 'oauth bag missing' };
  }
  const o = oauthRaw as Record<string, unknown>;
  if (
    typeof o['accessToken'] !== 'string' ||
    typeof o['refreshToken'] !== 'string' ||
    typeof o['expiresAt'] !== 'number' ||
    typeof o['clientId'] !== 'string' ||
    typeof o['clientSecret'] !== 'string'
  ) {
    return { ok: false, reason: 'oauth bag has invalid shape' };
  }
  return {
    ok: true,
    oauth: {
      accessToken: o['accessToken'],
      refreshToken: o['refreshToken'],
      expiresAt: o['expiresAt'],
      clientId: o['clientId'],
      clientSecret: o['clientSecret'],
    },
    credentialId: row.id,
    fullBag: bag,
  };
}

async function refreshOAuthToken(
  oauth: GdriveOAuthBag,
  httpFetch: typeof fetch,
): Promise<
  | { ok: true; oauth: GdriveOAuthBag }
  | { ok: false; reason: string; details: string }
> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
  });
  let res: Response;
  try {
    res = await httpFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'fetch-error',
      details: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: 'http-error',
      details: `token endpoint responded ${res.status}`,
    };
  }
  let payload: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    return {
      ok: false,
      reason: 'parse-error',
      details: (err as Error).message,
    };
  }
  if (
    typeof payload.access_token !== 'string' ||
    !payload.access_token ||
    typeof payload.expires_in !== 'number'
  ) {
    return { ok: false, reason: 'invalid-response', details: 'missing access_token / expires_in' };
  }
  const newRefresh =
    typeof payload.refresh_token === 'string' && payload.refresh_token
      ? payload.refresh_token
      : oauth.refreshToken;
  return {
    ok: true,
    oauth: {
      accessToken: payload.access_token,
      refreshToken: newRefresh,
      expiresAt: Date.now() + payload.expires_in * 1000,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
    },
  };
}

async function persistRefreshedOAuth(
  credentialId: string,
  fresh: GdriveOAuthBag,
  existingBag: Record<string, unknown>,
  dbUrl: string | undefined,
): Promise<void> {
  const secret = process.env.LOOTGOBLIN_SECRET;
  if (!secret) return;
  const db = getServerDb(dbUrl);

  // Merge with existing bag — preserve api-key etc. for dual mode.
  let merged: Record<string, unknown>;
  if (existingBag['kind'] === 'oauth+api-key') {
    merged = {
      ...existingBag,
      oauth: {
        ...((existingBag['oauth'] as Record<string, unknown>) ?? {}),
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        clientId: fresh.clientId,
        clientSecret: fresh.clientSecret,
      },
    };
  } else {
    merged = {
      ...existingBag,
      kind: 'oauth',
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
      clientId: fresh.clientId,
      clientSecret: fresh.clientSecret,
    };
  }
  const blob = JSON.stringify(merged);
  const encrypted = encrypt(blob, secret);
  await db
    .update(schema.sourceCredentials)
    .set({
      encryptedBlob: Buffer.from(encrypted),
      lastUsedAt: new Date(),
    })
    .where(eq(schema.sourceCredentials.id, credentialId));
}

async function getStartPageToken(
  accessToken: string,
  httpFetch: typeof fetch,
): Promise<
  | { ok: true; pageToken: string }
  | { ok: false; status?: number; details: string }
> {
  let res: Response;
  try {
    res = await httpFetch(`${DRIVE_API_BASE}/changes/startPageToken`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return { ok: false, details: `fetch failed: ${err instanceof Error ? err.message : err}` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, details: `HTTP ${res.status}` };
  }
  let payload: { startPageToken?: unknown };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    return { ok: false, details: `parse failed: ${(err as Error).message}` };
  }
  if (typeof payload.startPageToken !== 'string' || !payload.startPageToken) {
    return { ok: false, details: 'missing startPageToken in response' };
  }
  return { ok: true, pageToken: payload.startPageToken };
}

function parseWatchResponse(
  raw: unknown,
):
  | { ok: true; channelId: string; resourceId: string; expirationMs: number }
  | { ok: false; details: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, details: 'response not an object' };
  }
  const r = raw as Record<string, unknown>;
  const id = r['id'];
  const resourceId = r['resourceId'];
  const expiration = r['expiration'];
  if (typeof id !== 'string' || !id) {
    return { ok: false, details: 'response missing id' };
  }
  if (typeof resourceId !== 'string' || !resourceId) {
    return { ok: false, details: 'response missing resourceId' };
  }
  let expirationMs = Date.now() + TTL_MS;
  if (typeof expiration === 'string' && expiration) {
    const n = Number(expiration);
    if (Number.isFinite(n) && n > 0) expirationMs = n;
  } else if (typeof expiration === 'number' && Number.isFinite(expiration)) {
    expirationMs = expiration;
  }
  return { ok: true, channelId: id, resourceId, expirationMs };
}

/**
 * Strip values that look like access tokens from an arbitrary error body.
 * This is best-effort only — Google's error responses don't normally echo
 * tokens, but a thrown library could leak `Authorization: Bearer …` in a
 * stack trace.
 */
function redactBody(body: string): string {
  if (body.length > 800) body = body.slice(0, 800) + '…';
  return body
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[REDACTED]"');
}
