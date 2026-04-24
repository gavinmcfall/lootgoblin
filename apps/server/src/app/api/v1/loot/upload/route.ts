/**
 * POST /api/v1/loot/upload — V2-003-T4
 *
 * Accepts a multipart/form-data request with:
 *   - metadata: JSON string with collectionId + item metadata
 *   - files:    one or more File parts containing the upload payloads
 *
 * Flow:
 *   1. Authenticate via session or API key.
 *   2. Parse multipart body (req.formData()).
 *   3. Validate + parse metadata JSON field via Zod.
 *   4. ACL check: caller must have `update` on the target Collection.
 *   5. Verify the collection exists.
 *   6. Write each file to a per-request tempDir (/tmp/lootgoblin-upload-<uuid>/).
 *   7. Hand tempDir + metadata to the upload adapter via createIngestPipeline.
 *   8. Return 202 Accepted with the IngestOutcome.
 *
 * Filename sanitization strips path-traversal sequences (../, .\, leading
 * dots, null bytes, control characters) before writing to tempDir.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';

import { authenticateRequest, INVALID_API_KEY } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { getDb, schema } from '@/db/client';
import { eq } from 'drizzle-orm';
import { createDefaultRegistry, createIngestPipeline } from '@/scavengers';
import { logger } from '@/logger';

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const UploadMetadataBody = z.object({
  collectionId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  creator: z.string().max(200).optional(),
  license: z.string().max(200).optional(),
  tags: z.array(z.string().max(100)).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Process-level singleton registry
//
// createDefaultRegistry() is cheap (in-memory Map), but we share the instance
// so adapter state (if any future adapter caches credentials) is stable across
// requests.
// ---------------------------------------------------------------------------

const _registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB total upload

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const user = await authenticateRequest(req);
  if (user === INVALID_API_KEY) {
    return NextResponse.json(
      { error: 'unauthenticated', reason: 'invalid-api-key' },
      { status: 401 },
    );
  }
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // ── 2. Parse multipart ───────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    logger.warn({ err }, 'loot/upload: multipart parse failed');
    return NextResponse.json(
      { error: 'invalid-body', reason: 'multipart parse failed' },
      { status: 400 },
    );
  }

  // ── 3. Parse + validate metadata JSON blob ───────────────────────────────
  const metaField = formData.get('metadata');
  if (typeof metaField !== 'string') {
    return NextResponse.json(
      { error: 'invalid-body', reason: "missing 'metadata' field" },
      { status: 400 },
    );
  }

  let metaParsed: unknown;
  try {
    metaParsed = JSON.parse(metaField);
  } catch {
    return NextResponse.json(
      { error: 'invalid-body', reason: "'metadata' is not valid JSON" },
      { status: 400 },
    );
  }

  const metaCheck = UploadMetadataBody.safeParse(metaParsed);
  if (!metaCheck.success) {
    return NextResponse.json(
      { error: 'invalid-body', issues: metaCheck.error.issues },
      { status: 400 },
    );
  }

  const { collectionId, ...metadata } = metaCheck.data;

  // ── 4. Collection existence + ACL check ──────────────────────────────────
  const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  const collectionRows = await db
    .select({ ownerId: schema.collections.ownerId })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
    .limit(1);

  const collectionRow = collectionRows[0];
  if (!collectionRow) {
    return NextResponse.json(
      { error: 'not-found', reason: 'collection-not-found' },
      { status: 404 },
    );
  }

  const acl = resolveAcl({
    user,
    resource: { kind: 'collection', ownerId: collectionRow.ownerId },
    action: 'update',
  });
  if (!acl.allowed) {
    return NextResponse.json(
      { error: 'forbidden', reason: acl.reason },
      { status: 403 },
    );
  }

  // ── 5. Collect + validate files ───────────────────────────────────────────
  const files = formData.getAll('files').filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return NextResponse.json(
      { error: 'invalid-body', reason: "no files in 'files' field" },
      { status: 400 },
    );
  }

  // Total-size cap.
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: 'payload-too-large', reason: `upload total exceeds ${MAX_UPLOAD_BYTES} bytes` },
      { status: 413 },
    );
  }

  // ── 6. Stage files to tempDir ─────────────────────────────────────────────
  const uploadId = randomUUID();
  const tempDir = path.join(os.tmpdir(), `lootgoblin-upload-${uploadId}`);
  await fsp.mkdir(tempDir, { recursive: true });

  try {
    for (const file of files) {
      const safe = sanitizeUploadFilename(file.name) ?? `upload-${randomUUID()}.bin`;
      const buf = Buffer.from(await file.arrayBuffer());
      await fsp.writeFile(path.join(tempDir, safe), buf);
    }
  } catch (err) {
    logger.warn({ err, uploadId }, 'loot/upload: failed staging files to tempDir');
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json(
      { error: 'upload-staging-failed', reason: (err as Error).message },
      { status: 500 },
    );
  }

  // ── 7. Resolve upload adapter ─────────────────────────────────────────────
  const adapter = _registry.getById('upload');
  if (!adapter) {
    // Should never happen — upload adapter is always registered in createDefaultRegistry.
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json(
      { error: 'internal', reason: 'upload adapter not registered' },
      { status: 500 },
    );
  }

  // ── 8. Run ingest pipeline ────────────────────────────────────────────────
  const pipeline = createIngestPipeline({
    ownerId: user.id,
    collectionId,
  });

  const outcome = await pipeline.run({
    adapter,
    target: {
      kind: 'raw',
      payload: { tempDir, metadata } satisfies import('@/scavengers').UploadRawPayload,
    },
  });

  return NextResponse.json(outcome, { status: 202 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize an upload filename to prevent path traversal, null bytes, and
 * control characters.
 *
 * Returns null when the input is empty or results in an empty string after
 * sanitization (caller should substitute a safe fallback name).
 *
 * Rules:
 *   - Strip everything up to and including the last path separator (/ or \)
 *     to prevent directory traversal.
 *   - Remove null bytes (\0) and ASCII control characters (0x01–0x1F).
 *   - Strip leading dots (prevents hidden-file creation).
 *   - Truncate to 255 bytes (filesystem limit on most platforms).
 */
export function sanitizeUploadFilename(raw: string): string | null {
  if (!raw) return null;

  // Strip path traversal: take only the basename component.
  const base = raw.split(/[/\\]/).pop();
  if (!base) return null;

  // Remove null bytes and ASCII control characters (U+0000–U+001F).
  const noControl = base.replace(/[\x00-\x1F]/g, '');

  // Strip leading dots (prevents hidden files like .env, ..evil).
  const cleaned = noControl.replace(/^\.+/, '');

  if (cleaned.length === 0) return null;

  // Truncate to 255 bytes (UTF-8 aware).
  const truncated = Buffer.from(cleaned).slice(0, 255).toString('utf8');

  return truncated.length > 0 ? truncated : null;
}
