/**
 * Shared helpers for /api/v1/catalog/* routes — V2-007b T_B2.
 *
 * Centralises:
 *   - Auth (mirrors /api/v1/materials/_shared.ts requireAuth).
 *   - DTO mappers — DB row → JSON (Date → ISO string).
 *   - Reason→HTTP status mapping for the catalog domain layer.
 *   - Error envelope shared across catalog routes.
 *
 * Why a separate _shared.ts (not the materials one): the catalog read model
 * is fundamentally different — system rows (`owner_id IS NULL`) are visible
 * to every authenticated caller, whereas materials are owner-scoped only
 * (admin-readable for reporting). The materials ACL kind doesn't fit, so we
 * enforce visibility inline in the domain layer (catalog.ts) and skip the
 * resolveAcl call here.
 */

import { NextResponse } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
  type AuthenticatedActor,
} from '@/auth/request-auth';
import type { FilamentProduct, ResinProduct } from '@/materials/catalog-types';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AuthOk = { ok: true; actor: AuthenticatedActor };
export type AuthErr = { ok: false; response: Response };
export type AuthResult = AuthOk | AuthErr;

export async function requireAuth(req: Request): Promise<AuthResult> {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return {
      ok: false,
      response: unauthenticatedResponse(actor as null | typeof INVALID_API_KEY),
    };
  }
  return { ok: true, actor };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface FilamentProductDto {
  id: string;
  brand: string;
  productLine: string | null;
  subtype: string;
  colors: string[];
  colorPattern: string;
  colorName: string | null;
  defaultTemps: {
    nozzle_min?: number;
    nozzle_max?: number;
    bed?: number;
    chamber?: number;
  } | null;
  diameterMm: number | null;
  density: number | null;
  spoolWeightG: number | null;
  emptySpoolWeightG: number | null;
  finish: string | null;
  pattern: string | null;
  isGlow: boolean | null;
  isTranslucent: boolean | null;
  retailUrl: string | null;
  slicerId: string | null;
  ownerId: string | null;
  source: string;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toFilamentProductDto(row: FilamentProduct): FilamentProductDto {
  return {
    id: row.id,
    brand: row.brand,
    productLine: row.productLine ?? null,
    subtype: row.subtype,
    colors: row.colors,
    colorPattern: row.colorPattern,
    colorName: row.colorName ?? null,
    defaultTemps: row.defaultTemps ?? null,
    diameterMm: row.diameterMm ?? null,
    density: row.density ?? null,
    spoolWeightG: row.spoolWeightG ?? null,
    emptySpoolWeightG: row.emptySpoolWeightG ?? null,
    finish: row.finish ?? null,
    pattern: row.pattern ?? null,
    isGlow: row.isGlow ?? null,
    isTranslucent: row.isTranslucent ?? null,
    retailUrl: row.retailUrl ?? null,
    slicerId: row.slicerId ?? null,
    ownerId: row.ownerId ?? null,
    source: row.source,
    sourceRef: row.sourceRef ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ResinProductDto {
  id: string;
  brand: string;
  productLine: string | null;
  subtype: string;
  colors: string[] | null;
  colorName: string | null;
  defaultExposure: {
    layer_height_mm?: number;
    exposure_seconds?: number;
    bottom_layers?: number;
    bottom_exposure_seconds?: number;
    lift_speed_mm_min?: number;
  } | null;
  densityGMl: number | null;
  viscosityCps: number | null;
  bottleVolumeMl: number | null;
  compatibility: { wavelength_nm?: number; printer_compat?: string[] } | null;
  materialClass: string | null;
  retailUrl: string | null;
  ownerId: string | null;
  source: string;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toResinProductDto(row: ResinProduct): ResinProductDto {
  return {
    id: row.id,
    brand: row.brand,
    productLine: row.productLine ?? null,
    subtype: row.subtype,
    colors: row.colors ?? null,
    colorName: row.colorName ?? null,
    defaultExposure: row.defaultExposure ?? null,
    densityGMl: row.densityGMl ?? null,
    viscosityCps: row.viscosityCps ?? null,
    bottleVolumeMl: row.bottleVolumeMl ?? null,
    compatibility: row.compatibility ?? null,
    materialClass: row.materialClass ?? null,
    retailUrl: row.retailUrl ?? null,
    ownerId: row.ownerId ?? null,
    source: row.source,
    sourceRef: row.sourceRef ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: string,
): Response {
  const body: Record<string, unknown> = { error: code, message };
  if (details !== undefined) body.details = details;
  return NextResponse.json(body, { status });
}

/**
 * Map domain reason codes to HTTP status.
 *  - 'persist-failed'                                  → 500
 *  - 'not-found'                                       → 404
 *  - 'admin-required' | 'cannot-impersonate-owner'     → 403
 *  - 'id-conflict'                                     → 409
 *  - all other validation reasons                      → 400
 */
export function statusForReason(reason: string): number {
  if (reason === 'persist-failed') return 500;
  if (reason === 'not-found') return 404;
  if (reason === 'admin-required') return 403;
  if (reason === 'cannot-impersonate-owner') return 403;
  if (reason === 'id-conflict') return 409;
  return 400;
}
