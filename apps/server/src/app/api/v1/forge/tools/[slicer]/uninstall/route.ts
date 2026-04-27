/**
 * DELETE /api/v1/forge/tools/[slicer]/uninstall — V2-005c T_c6
 *
 * Removes the install row and best-effort `fsp.rm`s the install_root.
 * `removeInstall` returns `{ removed: false, deletedRoot: null }` when no
 * row exists — we still 200 in that case so the UI can call uninstall as a
 * confirm-then-delete idempotent action.
 *
 * Admin-only (mirrors /api/v1/agents).
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { removeInstall } from '@/forge/slicer/registry';
import { parseSlicerKind } from '@/forge/slicer/route-helpers';

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ slicer: string }> },
) {
  const { slicer } = await ctx.params;

  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }
  if (actor.role !== 'admin') {
    return NextResponse.json(
      { error: 'forbidden', reason: 'admin-only' },
      { status: 403 },
    );
  }

  const slicerKind = parseSlicerKind(slicer);
  if (!slicerKind) {
    return NextResponse.json(
      {
        error: 'invalid-slicer-kind',
        reason: `unknown slicer kind: ${String(slicer)}`,
      },
      { status: 400 },
    );
  }

  const result = await removeInstall({ slicerKind });
  return NextResponse.json(result, { status: 200 });
}
