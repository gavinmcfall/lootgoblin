/**
 * GET /api/v1/forge/slicers/launch-uri — V2-005e-T_e4
 *
 * Resolves a slicer-launch deep-link for a given (slicerKind, lootFileId)
 * pair. Future UI buttons navigate to `uri` to open the operator's locally
 * installed slicer with the file pre-loaded; if the slicer has no
 * registered URI scheme, the response is `{uri: "", fallback: "download"}`
 * and the caller is expected to fall back to a Content-Disposition
 * download instead.
 *
 * Auth + ACL
 * ──────────
 *   - Standard /api/v1/forge auth (BetterAuth session OR scoped api key).
 *   - Caller must own the parent Loot of the requested loot_file. Loot
 *     ownership lives on the parent Collection (loot has no ownerId
 *     column — same shape as the existing /api/v1/loot/[id] route).
 *   - Cross-owner / unknown lootFile both surface as 404 to avoid leaking
 *     loot_file ids across users.
 *   - Admin reads ALLOWED for fleet visibility (matches forge _shared
 *     `loadPrinterForActor`/`loadSlicerForActor` admin policy).
 *
 * File-URL construction
 * ─────────────────────
 *   {baseUrl}/api/v1/loot/files/{lootFileId}
 * where `baseUrl` is `LOOTGOBLIN_PUBLIC_URL` if set, else the request
 * origin. The file-serve route itself is delivered separately
 * (V2-005e-T_e5 / future); this endpoint only renders the URL the
 * launched slicer should fetch from. Existing `/api/v1/loot/{id}/files`
 * lists files for a loot but does not serve content; the launch-time
 * serve route is owed but a stable URL shape is fine to commit now —
 * see the file-serve TODO in `app/api/v1/loot/[id]/files/route.ts`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import {
  SLICER_LAUNCH_REGISTRY,
  isSlicerKind,
  renderLaunchUri,
  type SlicerKind,
} from '@/forge/slicers/launch-registry';

import { errorResponse, requireAuth } from '../../_shared';

const Query = z.object({
  slicerKind: z.string().min(1),
  lootFileId: z.string().min(1),
});

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return errorResponse('invalid-query', 'missing required query params', 400);
  }

  if (!isSlicerKind(parsed.data.slicerKind)) {
    return errorResponse(
      'unknown-slicer-kind',
      `unknown slicer kind: ${parsed.data.slicerKind}; valid: ${Object.keys(SLICER_LAUNCH_REGISTRY).join(', ')}`,
      400,
    );
  }
  const slicerKind: SlicerKind = parsed.data.slicerKind;

  const db = getServerDb();
  const lootFileRows = await db
    .select()
    .from(schema.lootFiles)
    .where(eq(schema.lootFiles.id, parsed.data.lootFileId))
    .limit(1);
  if (lootFileRows.length === 0) {
    return errorResponse('not-found', 'loot-file-not-found', 404);
  }

  // ACL: actor must own the parent Loot's Collection (or be admin).
  // Loot has no ownerId column — ownership flows through `collections.ownerId`.
  const lootRows = await db
    .select({ collectionId: schema.loot.collectionId })
    .from(schema.loot)
    .where(eq(schema.loot.id, lootFileRows[0]!.lootId))
    .limit(1);
  if (lootRows.length === 0) {
    return errorResponse('not-found', 'loot-file-not-found', 404);
  }
  const collectionRows = await db
    .select({ ownerId: schema.collections.ownerId })
    .from(schema.collections)
    .where(eq(schema.collections.id, lootRows[0]!.collectionId))
    .limit(1);
  if (collectionRows.length === 0) {
    return errorResponse('not-found', 'loot-file-not-found', 404);
  }
  if (
    auth.actor.role !== 'admin' &&
    collectionRows[0]!.ownerId !== auth.actor.id
  ) {
    return errorResponse('not-found', 'loot-file-not-found', 404);
  }

  // Build the file-serving URL. Prefer LOOTGOBLIN_PUBLIC_URL when set so
  // operators behind reverse proxies render canonical URLs; fall back to
  // the request origin otherwise.
  const baseUrl =
    process.env.LOOTGOBLIN_PUBLIC_URL?.replace(/\/+$/, '') ?? new URL(req.url).origin;
  const fileUrl = `${baseUrl}/api/v1/loot/files/${parsed.data.lootFileId}`;

  const { uri, fallback } = renderLaunchUri(slicerKind, fileUrl);
  return NextResponse.json({ uri, fallback });
}
