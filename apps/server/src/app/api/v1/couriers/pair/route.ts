/**
 * POST /api/v1/couriers/pair — V2-006a-T4
 *
 * Credential-less endpoint: the pair token IS the credential.
 *
 * The Courier (or operator) posts the one-time token received from the admin
 * UI along with optional metadata. On success the response carries a
 * long-lived `courier_pairing`-scoped API key and the new Agent's id.
 *
 * The returned `api_key` is the plaintext key (shown once, never stored).
 * The Courier stores it and presents it in the `x-api-key` header on all
 * subsequent calls to courier-authenticated routes. `authenticateCourier`
 * in courier-auth.ts resolves it to the Agent via `agents.pair_credential_ref`.
 *
 * Error codes:
 *   400 invalid-pair-token / reason: invalid-or-expired — bad signature or past expiry
 *   400 invalid-pair-token / reason: wrong-kind         — non-courier token presented
 *   409 pair-token-already-used                         — nonce replay
 *   500 internal                                        — unexpected failure
 *
 * No auth — the pair token IS the credential. This endpoint must remain in
 * the middleware allowlist so it is not blocked by API-key enforcement on the
 * central-worker routes.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { exchangeCourierPairToken } from '@/forge/couriers';

const BodySchema = z.object({
  token: z.string().min(1),
  name: z.string().optional(),
  reachable_lan_hint: z.string().optional().nullable(),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', reason: parsed.error.flatten() },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  const result = await exchangeCourierPairToken(body.token, {
    name: body.name,
    reachable_lan_hint: body.reachable_lan_hint ?? null,
  });

  if (!result.ok) {
    if (result.status === 400 || result.status === 409) {
      return NextResponse.json(
        result.status === 409
          ? { error: result.error }
          : { error: result.error, reason: result.reason },
        { status: result.status },
      );
    }
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    api_key: result.api_key,
    agent_id: result.agent_id,
    instance_id: result.instance_id,
    server_version: result.server_version,
  });
}
