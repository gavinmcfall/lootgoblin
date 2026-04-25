/**
 * POST /api/v1/source-auth/:sourceId/oauth/start — V2-003-T9
 *
 * Returns an authorize-redirect URL for the source's OAuth provider plus an
 * opaque `state` value the caller embeds in the redirect. The state row is
 * persisted server-side (oauth_state) for callback validation, with a 10-minute
 * TTL.
 *
 * Body:
 *   { redirectUri: string, clientId: string }
 *
 * The clientId is supplied by the caller (configured in the UI per-instance);
 * we don't persist it here — it's also sent in the callback for the token
 * exchange.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  authorizeWrite,
  createOAuthState,
  pkceChallenge,
  providerConfigFor,
} from '../../_shared';

const Body = z.object({
  redirectUri: z.string().url(),
  clientId: z.string().min(1).max(512),
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

  const { state, codeVerifier } = await createOAuthState({
    userId: auth.actor.id,
    sourceId: auth.sourceId,
    pkce: provider.requiresPkce,
    redirectUri: parsed.data.redirectUri,
  });

  // Build the authorize URL.
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', parsed.data.clientId);
  url.searchParams.set('redirect_uri', parsed.data.redirectUri);
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('state', state);
  if (provider.requiresPkce && codeVerifier) {
    url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    // Google requires this for refresh_token issuance on first consent.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }

  return NextResponse.json({
    authorizationUrl: url.toString(),
    state,
  });
}
