/**
 * GET /api/v1/catalog/resins/search?q=...&limit=... — V2-007b T_B2.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { searchResinProducts } from '@/materials/catalog';

import {
  errorResponse,
  requireAuth,
  statusForReason,
  toResinProductDto,
} from '../../_shared';

const Query = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const parsed = Query.safeParse({
    q: url.searchParams.get('q') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid-query',
        message: 'invalid query parameters',
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const result = await searchResinProducts({
    actorUserId: auth.actor.id,
    actorRole: auth.actor.role,
    prefix: parsed.data.q,
    limit: parsed.data.limit,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `search rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json({
    products: result.products.map(toResinProductDto),
  });
}
