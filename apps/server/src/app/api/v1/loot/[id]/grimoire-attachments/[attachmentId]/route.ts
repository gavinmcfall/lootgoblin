/**
 * DELETE /api/v1/loot/:id/grimoire-attachments/:attachmentId — V2-007a-T14
 *
 * Wraps T11 detachFromLoot. Cross-owner / missing → 404.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { detachFromLoot } from '@/grimoire/attachment';

import {
  errorResponse,
  requireAuth,
  statusForReason,
} from '../../../../grimoire/_shared';

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const { attachmentId } = await context.params;
  const auth = await requireAuth(_req);
  if (!auth.ok) return auth.response;

  const result = await detachFromLoot({
    attachmentId,
    ownerId: auth.actor.id,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `detach rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return new Response(null, { status: 204 });
}

// Optional GET to fetch a single attachment by id (defensive; not in spec).
// Ship as 405 by omission.
export async function GET() {
  return NextResponse.json(
    { error: 'method-not-allowed', message: 'use the parent collection route to list attachments' },
    { status: 405 },
  );
}
