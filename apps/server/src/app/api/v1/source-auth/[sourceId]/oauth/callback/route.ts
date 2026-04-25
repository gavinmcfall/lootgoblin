/**
 * POST /api/v1/source-auth/:sourceId/oauth/callback — V2-003-T9
 *
 * Exchanges an authorization `code` for tokens via the source's OAuth token
 * endpoint, then persists the encrypted bag to source_credentials.
 *
 * Body:
 *   {
 *     code: string,
 *     state: string,
 *     clientId: string,
 *     clientSecret?: string,    // required for non-PKCE (Sketchfab)
 *   }
 *
 * NOTE: `redirect_uri` is NOT taken from the request body — we use the
 * value pinned at /oauth/start time (stored on the oauth_state row). A
 * mismatch between start-time and callback-time redirect_uri can otherwise
 * be exploited if the OAuth client is misconfigured with a wildcard
 * redirect allowlist.
 *
 * State validation uses {@link consumeOAuthState} which atomically deletes
 * the row via `DELETE … RETURNING`. Replay races (two concurrent callbacks
 * with the same state) are defended at the SQL layer — the second sees no
 * row and 400s.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  authorizeWrite,
  consumeOAuthState,
  providerConfigFor,
  upsertSourceCredential,
} from '../../_shared';
import { logger } from '@/logger';

const Body = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
});

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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-body', reason: 'JSON parse failed' }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-body', issues: parsed.error.issues }, { status: 400 });
  }

  if (!provider.requiresPkce && !parsed.data.clientSecret) {
    return NextResponse.json(
      { error: 'invalid-body', reason: 'clientSecret required for this provider' },
      { status: 400 },
    );
  }

  // Atomically consume the state row (DELETE … RETURNING). The function does
  // length-checked timingSafeEqual on the returned state, validates owner +
  // sourceId + expiry, and never returns a row that another caller could
  // also see. If the row is missing/expired/mismatched we 400.
  const stateRow = await consumeOAuthState({
    userId: auth.actor.id,
    sourceId: auth.sourceId,
    state: parsed.data.state,
  });
  if (!stateRow) {
    return NextResponse.json(
      { error: 'invalid-state', reason: 'state value unknown, mismatched, or expired' },
      { status: 400 },
    );
  }
  if (!stateRow.redirectUri) {
    // Defensive — should not happen since /oauth/start always persists one.
    return NextResponse.json(
      { error: 'invalid-state', reason: 'state row missing redirect_uri' },
      { status: 400 },
    );
  }

  // Exchange code for tokens. Use the state-time redirect_uri exclusively.
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: parsed.data.code,
    redirect_uri: stateRow.redirectUri,
    client_id: parsed.data.clientId,
  });
  if (parsed.data.clientSecret) params.set('client_secret', parsed.data.clientSecret);
  if (provider.requiresPkce && stateRow.codeVerifier) {
    params.set('code_verifier', stateRow.codeVerifier);
  }

  let tokenRes: Response;
  try {
    tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });
  } catch (err) {
    logger.warn({ err, sourceId: auth.sourceId }, 'source-auth/oauth/callback: token exchange fetch failed');
    return NextResponse.json(
      { error: 'upstream-failure', reason: 'token endpoint unreachable' },
      { status: 502 },
    );
  }

  if (!tokenRes.ok) {
    // Server-side log captures the upstream body for diagnostics. The
    // response to the client redacts the body — providers can echo back
    // request fragments (correlation ids, sometimes secrets) and we don't
    // want any of that leaking to the user-agent.
    let upstreamBody: unknown = null;
    try {
      upstreamBody = await tokenRes.json();
    } catch {
      upstreamBody = await tokenRes.text().catch(() => null);
    }
    logger.warn(
      { sourceId: auth.sourceId, upstreamStatus: tokenRes.status, upstreamBody },
      'source-auth/oauth/callback: token exchange failed',
    );
    return NextResponse.json(
      {
        error: 'token-exchange-failed',
        upstreamStatus: tokenRes.status,
      },
      { status: 400 },
    );
  }

  let tokenJson: unknown;
  try {
    tokenJson = await tokenRes.json();
  } catch {
    return NextResponse.json(
      { error: 'token-exchange-failed', reason: 'token response was not JSON' },
      { status: 502 },
    );
  }

  const payload = tokenJson as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
    scope?: unknown;
  };

  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    return NextResponse.json(
      { error: 'token-exchange-failed', reason: 'missing access_token' },
      { status: 502 },
    );
  }

  let expiresIn: number;
  if (typeof payload.expires_in === 'number') {
    expiresIn = payload.expires_in;
  } else {
    logger.warn(
      { sourceId: auth.sourceId },
      'source-auth/oauth/callback: upstream token response missing expires_in — defaulting to 3600s',
    );
    expiresIn = 3600;
  }
  const expiresAtMs = Date.now() + expiresIn * 1000;

  const bag: Record<string, unknown> = {
    kind: 'oauth',
    accessToken: payload.access_token,
    expiresAt: expiresAtMs,
    clientId: parsed.data.clientId,
    ...(parsed.data.clientSecret ? { clientSecret: parsed.data.clientSecret } : {}),
  };
  if (typeof payload.refresh_token === 'string' && payload.refresh_token) {
    bag.refreshToken = payload.refresh_token;
  }
  if (typeof payload.token_type === 'string') bag.tokenType = payload.token_type;
  if (typeof payload.scope === 'string') bag.scope = payload.scope;

  const result = await upsertSourceCredential({
    sourceId: auth.sourceId,
    kind: 'oauth-token',
    bag,
    expiresAt: new Date(expiresAtMs),
  });

  // No explicit row deletion — consumeOAuthState already performed the
  // DELETE … RETURNING above.

  return NextResponse.json({
    ok: true,
    sourceId: auth.sourceId,
    credentialId: result.id,
    expiresAt: expiresAtMs,
  });
}
