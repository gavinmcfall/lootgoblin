/**
 * POST   /api/v1/forge/printers/:id/credentials  — create/rotate credential
 * GET    /api/v1/forge/printers/:id/credentials  — fetch metadata (NOT payload)
 * DELETE /api/v1/forge/printers/:id/credentials  — remove credential
 *
 * V2-005d-a T_da3. Per-printer encrypted dispatch credential management.
 *
 * Auth model
 * ──────────
 * BetterAuth session OR programmatic x-api-key (loadPrinterForActor handles
 * this via the standard /api/v1/forge/_shared helper).
 *
 * ACL deviation from the task spec — adapted, see header on _shared.ts and
 * acl/resolver.ts case 'printer'. The repo's printer mutation pattern is
 * OWNER-ONLY: admins do NOT bypass printer ACL (consent model). The T_da3
 * spec mentions "owner OR admin"; that would conflict with V2-005a-T5's
 * established consent model and the ACL resolver's documented invariant
 * ("Printers and slicers are personal devices. Admins cannot bypass printer
 * or slicer ACL"). Credentials are strictly more sensitive than printer
 * config, so we honor the stronger owner-only rule. Cross-owner access
 * returns 404 (matches the printer route's id-leak prevention pattern), not
 * 403.
 *
 * Security boundary — GET response NEVER includes any decrypted payload,
 * encrypted blob, or any field that could carry credential material. Only
 * { kind, label, lastUsedAt, hasCredential: true } is exposed. Error
 * responses likewise must never include credential material.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { logger } from '@/logger';
import {
  setCredential,
  getCredential,
  removeCredential,
} from '@/forge/dispatch/credentials';
import { FORGE_TARGET_CREDENTIAL_KINDS } from '@/db/schema.forge';

import { errorResponse, loadPrinterForActor } from '../../../_shared';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PayloadSchemas = {
  moonraker_api_key: z.object({ apiKey: z.string().min(1).max(256) }),
  octoprint_api_key: z.object({ apiKey: z.string().min(1).max(256) }),
  bambu_lan: z.object({
    accessCode: z.string().min(1).max(64),
    serial: z.string().min(1).max(64),
  }),
  sdcp_passcode: z.object({ passcode: z.string().max(64).optional() }),
} as const;

const PostBody = z.object({
  kind: z.enum(FORGE_TARGET_CREDENTIAL_KINDS),
  payload: z.unknown(),
  label: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }

  const parsedOuter = PostBody.safeParse(raw);
  if (!parsedOuter.success) {
    return NextResponse.json(
      {
        error: 'invalid-body',
        message: 'request body failed validation',
        issues: parsedOuter.error.issues,
      },
      { status: 400 },
    );
  }
  const { kind, payload, label } = parsedOuter.data;

  const payloadSchema = PayloadSchemas[kind];
  const parsedPayload = payloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    return NextResponse.json(
      {
        error: 'invalid-body',
        message: 'payload failed validation for kind',
        issues: parsedPayload.error.issues,
      },
      { status: 400 },
    );
  }

  const loaded = await loadPrinterForActor(req, id, 'update');
  if (!loaded.ok) return loaded.response;

  try {
    setCredential({
      printerId: id,
      kind,
      payload: parsedPayload.data,
      ...(label !== undefined ? { label } : {}),
    });
  } catch (err) {
    // Avoid leaking the underlying error message — could conceivably echo
    // payload material back if the crypto layer ever changes its error shape.
    logger.error(
      { err, printerId: id, kind },
      'POST /api/v1/forge/printers/:id/credentials: setCredential failed',
    );
    return errorResponse('internal', 'failed to store credential', 500);
  }

  return NextResponse.json(
    {
      printerId: id,
      kind,
      label: label ?? null,
      hasCredential: true,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET — METADATA ONLY. Never returns decrypted payload.
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const loaded = await loadPrinterForActor(req, id, 'update');
  if (!loaded.ok) return loaded.response;

  let cred;
  try {
    cred = getCredential({ printerId: id });
  } catch (err) {
    logger.error(
      { err, printerId: id },
      'GET /api/v1/forge/printers/:id/credentials: getCredential failed',
    );
    return errorResponse('internal', 'failed to load credential', 500);
  }

  if (!cred) {
    return errorResponse('not-found', 'no credential for printer', 404);
  }

  // SECURITY BOUNDARY: do NOT include payload, encryptedBlob, or any field
  // that could carry credential material.
  return NextResponse.json({
    kind: cred.kind,
    label: cred.label,
    lastUsedAt: cred.lastUsedAt ? cred.lastUsedAt.getTime() : null,
    hasCredential: true,
  });
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const loaded = await loadPrinterForActor(req, id, 'update');
  if (!loaded.ok) return loaded.response;

  let result: { removed: boolean };
  try {
    result = removeCredential({ printerId: id });
  } catch (err) {
    logger.error(
      { err, printerId: id },
      'DELETE /api/v1/forge/printers/:id/credentials: removeCredential failed',
    );
    return errorResponse('internal', 'failed to remove credential', 500);
  }

  return NextResponse.json({ removed: result.removed });
}
