/**
 * GET + DELETE /api/v1/source-auth/:sourceId — V2-003-T9
 *
 * GET    — read current credential status. NEVER returns the secret payload.
 * DELETE — revoke (remove the source_credentials row).
 *
 * See ./oauth/start/route.ts and siblings for OAuth + API-key set + refresh.
 *
 * Two-API-key boundary documentation: see ../../ingest/route.ts header.
 *
 * Coexists with the legacy /api/v1/source-credentials/[source]/route.ts
 * which still serves the extension's cookie-jar credential uploads.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  authorizeRead,
  authorizeWrite,
  deleteCredentials,
  readCredentialStatus,
} from './_shared';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ sourceId: string }> },
) {
  const { sourceId: rawId } = await context.params;
  const auth = await authorizeRead(req, rawId);
  if (!auth.ok) return auth.response;

  const status = await readCredentialStatus(auth.sourceId);
  return NextResponse.json({ sourceId: auth.sourceId, ...status });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ sourceId: string }> },
) {
  const { sourceId: rawId } = await context.params;
  const auth = await authorizeWrite(req, rawId);
  if (!auth.ok) return auth.response;

  const removed = await deleteCredentials(auth.sourceId);
  return NextResponse.json({ ok: true, sourceId: auth.sourceId, removed });
}
