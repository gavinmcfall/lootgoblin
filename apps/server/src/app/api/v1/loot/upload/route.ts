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
import {
  createDefaultRegistry,
  createIngestPipeline,
  sanitizeFilename,
  type IngestOutcome,
} from '@/scavengers';
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

// HMR-safe: stateless factory — createDefaultRegistry() returns a fresh Map-backed
// registry with no external state. Multiple module reloads during dev HMR produce
// independent registries that are functionally equivalent.
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

  // 'update' grants write access to collection contents — adding a Loot to a
  // Collection mutates the Collection's membership, so the uploader must have
  // update permission on the target. 'create' is NOT used because that action
  // refers to creating a Collection itself, not adding items to one.
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

  // Dedupe filenames: browsers don't enforce uniqueness of uploaded filenames,
  // and our sanitizer can also collide (e.g. '../model.stl' and './model.stl'
  // both sanitize to 'model.stl'). Without a counter, the second writeFile
  // would silently overwrite the first — user loses data with no feedback.
  // On first occurrence: use the base name as-is.
  // On subsequent occurrences: insert '-N' before the extension (model-1.stl).
  const seen = new Map<string, number>();
  try {
    for (const file of files) {
      const base = sanitizeFilename(file.name) ?? `upload-${randomUUID()}.bin`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);

      let safe = base;
      if (count > 0) {
        const ext = path.extname(base);
        const stem = base.slice(0, base.length - ext.length);
        safe = `${stem}-${count}${ext}`;
      }

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

  // pipeline.run() performs its initial ingest_jobs INSERT BEFORE its own
  // try/catch block. Any DB failure at that point (lock timeout, schema
  // mismatch mid-migration, FK violation) propagates uncaught and would leak
  // the tempDir. Wrap the run in a route-level guard so the tempDir is always
  // cleaned up and the caller sees a structured 500 instead of Next.js's
  // default error page.
  let outcome: IngestOutcome;
  try {
    outcome = await pipeline.run({
      adapter,
      target: {
        kind: 'raw',
        payload: { tempDir, metadata } satisfies import('@/scavengers').UploadRawPayload,
      },
    });
  } catch (err) {
    logger.error(
      { err, uploadId, collectionId },
      'loot/upload: pipeline.run() threw unexpectedly',
    );
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json(
      { error: 'internal', reason: 'pipeline error' },
      { status: 500 },
    );
  }

  return NextResponse.json(outcome, { status: 202 });
}

