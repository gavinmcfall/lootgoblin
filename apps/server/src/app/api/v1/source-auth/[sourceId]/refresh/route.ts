/**
 * POST /api/v1/source-auth/:sourceId/refresh — V2-003-T9
 *
 * Manually refreshes the OAuth access token for a source. Reads the stored
 * `refresh_token` + `client_id`/`client_secret` from the encrypted credential
 * bag, calls the source's token endpoint, and persists the new bag.
 *
 * Powers the "Test" button in the UI's source-auth panel. For sources with
 * `kind: 'api-key'` credentials, this is a no-op that returns 422.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  authorizeWrite,
  providerConfigFor,
  readDecryptedBag,
  upsertSourceCredential,
} from '../_shared';
import { logger } from '@/logger';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ sourceId: string }> },
) {
  const { sourceId: rawId } = await context.params;
  const auth = await authorizeWrite(req, rawId);
  if (!auth.ok) return auth.response;

  const provider = providerConfigFor(auth.sourceId);
  if (!provider) {
    return NextResponse.json(
      { error: 'unsupported-source', reason: `no OAuth provider configured for ${auth.sourceId}` },
      { status: 422 },
    );
  }

  const existing = await readDecryptedBag(auth.sourceId);
  if (!existing) {
    return NextResponse.json(
      { error: 'no-credentials', reason: 'no source_credentials row to refresh' },
      { status: 404 },
    );
  }
  if (existing.bag['kind'] !== 'oauth') {
    return NextResponse.json(
      { error: 'wrong-kind', reason: 'refresh only valid for OAuth credentials' },
      { status: 422 },
    );
  }

  const refreshToken = existing.bag['refreshToken'];
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return NextResponse.json(
      { error: 'no-refresh-token', reason: 'stored credential has no refresh_token' },
      { status: 422 },
    );
  }
  const clientId = existing.bag['clientId'];
  if (typeof clientId !== 'string' || !clientId) {
    return NextResponse.json(
      { error: 'no-client-id', reason: 'stored credential has no clientId' },
      { status: 422 },
    );
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const clientSecret = existing.bag['clientSecret'];
  if (typeof clientSecret === 'string' && clientSecret) {
    params.set('client_secret', clientSecret);
  }

  let res: Response;
  try {
    res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });
  } catch (err) {
    logger.warn({ err, sourceId: auth.sourceId }, 'source-auth/refresh: token endpoint unreachable');
    return NextResponse.json(
      { error: 'upstream-failure', reason: 'token endpoint unreachable' },
      { status: 502 },
    );
  }

  if (res.status === 400 || res.status === 401) {
    return NextResponse.json(
      { error: 'auth-revoked', reason: 'refresh_token rejected by upstream' },
      { status: 401 },
    );
  }
  if (!res.ok) {
    return NextResponse.json(
      { error: 'upstream-failure', upstreamStatus: res.status },
      { status: 502 },
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return NextResponse.json(
      { error: 'upstream-failure', reason: 'token response was not JSON' },
      { status: 502 },
    );
  }

  const payload = json as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
    scope?: unknown;
  };
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    return NextResponse.json(
      { error: 'upstream-failure', reason: 'missing access_token' },
      { status: 502 },
    );
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
  const expiresAtMs = Date.now() + expiresIn * 1000;

  // Sketchfab rotates refresh_tokens; Google does not. Keep prior on absent.
  const newRefreshToken =
    typeof payload.refresh_token === 'string' && payload.refresh_token
      ? payload.refresh_token
      : refreshToken;

  const newBag: Record<string, unknown> = {
    ...existing.bag,
    accessToken: payload.access_token,
    refreshToken: newRefreshToken,
    expiresAt: expiresAtMs,
  };
  if (typeof payload.token_type === 'string') newBag.tokenType = payload.token_type;
  if (typeof payload.scope === 'string') newBag.scope = payload.scope;

  await upsertSourceCredential({
    sourceId: auth.sourceId,
    kind: 'oauth-token',
    bag: newBag,
    expiresAt: new Date(expiresAtMs),
  });

  return NextResponse.json({ ok: true, sourceId: auth.sourceId, expiresAt: expiresAtMs });
}
