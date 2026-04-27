/**
 * GET /api/v1/forge/dispatch/compatibility
 *
 * V2-005a-T6 — exposes the TargetCompatibilityMatrix verdict for a single
 * (Loot, target kind) pair. The dispatch UI calls this per-target to drive
 * the native / conversion-required / unsupported badges.
 *
 * Query params:
 *   lootId      (required) — must be owned by caller (cross-owner → 404)
 *   targetKind  (required) — printer or slicer kind from FORGE_*_KINDS
 *
 * Response 200:
 *   {
 *     lootId: string,
 *     targetKind: string,
 *     format: string,            // detected primary format, '' if no files
 *     mixedFormat: boolean,      // multiple files with different formats
 *     band: 'native' | 'conversion-required' | 'unsupported',
 *     conversionTo?: string,
 *     reason?: string,
 *   }
 *
 * Errors:
 *   400 — invalid query (missing lootId / unknown targetKind)
 *   401 — auth missing
 *   404 — loot not found OR not owned by caller
 *   422 — loot has no files at all (nothing to dispatch)
 *
 * Auth: session OR programmatic API key via the shared requireAuth() helper.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  detectLootPrimaryFormat,
  getLootForOwner,
} from '@/forge/loot-format';
import {
  getCompatibility,
  isTargetKind,
} from '@/forge/target-compatibility';

import { errorResponse, requireAuth } from '../../_shared';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const lootId = url.searchParams.get('lootId');
  const targetKindRaw = url.searchParams.get('targetKind');

  if (!lootId || lootId.length === 0) {
    return errorResponse('invalid-query', 'lootId is required', 400);
  }
  if (!targetKindRaw || targetKindRaw.length === 0) {
    return errorResponse('invalid-query', 'targetKind is required', 400);
  }
  if (!isTargetKind(targetKindRaw)) {
    return errorResponse(
      'invalid-query',
      `targetKind must be a known printer or slicer kind; got '${targetKindRaw}'`,
      400,
    );
  }
  const targetKind = targetKindRaw;

  // Owner gate. Cross-owner / missing loot → 404 (don't leak existence).
  // Admins do NOT bypass this gate — compatibility is asked in the context
  // of "I want to dispatch MY loot to MY target", not fleet visibility.
  const owned = await getLootForOwner(lootId, actor.id);
  if (!owned) {
    return errorResponse('not-found', 'loot-not-found', 404);
  }

  const detection = await detectLootPrimaryFormat(lootId);
  if (detection.noFiles) {
    return errorResponse(
      'no-files',
      'loot has no files; nothing to dispatch',
      422,
    );
  }
  if (!detection.format) {
    // Files exist but none of them have a recognisable format → treat as
    // unsupported with an explanatory reason.
    return NextResponse.json({
      lootId,
      targetKind,
      format: '',
      mixedFormat: detection.mixedFormat,
      band: 'unsupported' as const,
      reason: 'Loot files have no recognisable format extension',
    });
  }

  const verdict = getCompatibility(detection.format, targetKind);
  return NextResponse.json({
    lootId,
    targetKind,
    format: detection.format,
    mixedFormat: detection.mixedFormat,
    band: verdict.band,
    ...(verdict.conversionTo ? { conversionTo: verdict.conversionTo } : {}),
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  });
}
