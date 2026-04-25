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
 *     redirectUri: string,
 *   }
 *
 * Validates `state` against an oauth_state row owned by the caller. Rejects
 * expired or unknown state with 400.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  authorizeWrite,
  consumeOAuthState,
  deleteOAuthState,
  providerConfigFor,
  upsertSourceCredential,
} from '../../_shared';
import { logger } from '@/logger';

const Body = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  redirectUri: z.string().url(),
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

  // Validate state.
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

  // Exchange code for tokens.
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: parsed.data.code,
    redirect_uri: parsed.data.redirectUri,
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
    let body: unknown = null;
    try {
      body = await tokenRes.json();
    } catch {
      body = await tokenRes.text().catch(() => null);
    }
    return NextResponse.json(
      {
        error: 'token-exchange-failed',
        upstreamStatus: tokenRes.status,
        upstreamBody: body,
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

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
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

  // Cleanup state row — single-use semantics.
  await deleteOAuthState(stateRow.id);

  return NextResponse.json({
    ok: true,
    sourceId: auth.sourceId,
    credentialId: result.id,
    expiresAt: expiresAtMs,
  });
}
