/**
 * POST /api/v1/source-auth/:sourceId/api-key — V2-003-T9
 *
 * Persists a static API key (or API token) credential for the given source.
 * Validates shape only (non-empty string) — does NOT make an upstream call
 * to test the key. UI clients can call /refresh afterwards if they want a
 * test ping.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { authorizeWrite, upsertSourceCredential } from '../_shared';

const Body = z.object({
  apiKey: z.string().min(1).max(4096),
});

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ sourceId: string }> },
) {
  const { sourceId: rawId } = await context.params;
  const auth = await authorizeWrite(req, rawId);
  if (!auth.ok) return auth.response;

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

  // Sketchfab refers to API keys as 'api-token'; our bag tags both as 'api-key'
  // shape with `{ kind: 'api-token' | 'api-key', token | apiKey }`. We persist
  // a generic `{ kind: 'api-key', apiKey }` bag — adapter validators accept it
  // when configured for that source.
  const bag = { kind: 'api-key', apiKey: parsed.data.apiKey };

  const result = await upsertSourceCredential({
    sourceId: auth.sourceId,
    kind: 'api-key',
    bag,
  });

  return NextResponse.json({ ok: true, sourceId: auth.sourceId, credentialId: result.id, created: result.created });
}
