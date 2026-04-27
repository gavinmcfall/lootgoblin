/**
 * POST /api/v1/forge/tools/[slicer]/install — V2-005c T_c6
 *
 * Kicks off the slicer install pipeline (download → verify → extract → ready)
 * in the background. The route returns 202 immediately after the installer
 * has marked the row as `downloading`; UI polls GET /api/v1/forge/tools to
 * track progress.
 *
 * Idempotency: if a row exists in an in-flight status (`downloading`,
 * `extracting`, `verifying`) we 409 with the current row instead of starting
 * a second pipeline. `ready` and `failed` rows fall through and re-run —
 * `installSlicer` upserts via ON CONFLICT, so re-running is safe.
 *
 * Admin-only (mirrors /api/v1/agents).
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { logger } from '@/logger';
import { installSlicer } from '@/forge/slicer/installer';
import { getInstall } from '@/forge/slicer/registry';
import {
  getInstallerDeps,
  parseSlicerKind,
} from '@/forge/slicer/route-helpers';

const IN_FLIGHT_STATUSES = new Set(['downloading', 'extracting', 'verifying']);

export async function POST(
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

  const existing = getInstall({ slicerKind });
  if (existing && IN_FLIGHT_STATUSES.has(existing.installStatus)) {
    return NextResponse.json(
      { error: 'install-in-progress', current: existing },
      { status: 409 },
    );
  }

  // Fire-and-forget. installSlicer upserts the row through 'downloading' →
  // 'verifying' → 'extracting' → 'ready'/'failed'; we don't await here so
  // the route returns to the caller as soon as the pipeline is launched.
  const deps = getInstallerDeps();
  void installSlicer({ slicerKind, http: deps.http, run: deps.run }).catch(
    (err: unknown) => {
      logger.error(
        { slicerKind, err: err instanceof Error ? err.message : String(err) },
        'POST /api/v1/forge/tools/install: background installer rejected',
      );
    },
  );

  return NextResponse.json(
    { slicerKind, installStatus: 'downloading' },
    { status: 202 },
  );
}
