// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * GET /api/v1/dispatch/artifact/:jobId — V2-006a-T7
 *
 * Serves the sliced-file bytes for a dispatch job to the authenticated Courier
 * agent that currently holds the claim.
 *
 * Authorization model:
 *   - Authenticated via `authenticateCourier(req)` — identity from the
 *     `x-api-key` header only (courier_pairing scope).
 *   - Authorized only if:
 *       (a) a dispatch_jobs row for `jobId` exists, AND
 *       (b) its `claim_marker === agentId`, AND
 *       (c) its `status` is 'claimed' or 'dispatched'.
 *   A Courier may only download artifacts for jobs it currently holds.
 *
 * Path-traversal guard:
 *   The `forge_artifacts.storage_path` column holds an absolute path written
 *   by the slicer worker under `<DATA_ROOT>/forge-artifacts/<jobId>/`.  We
 *   treat it as untrusted (a DB compromise or a bug must not allow reading
 *   arbitrary files).  We resolve the path and assert containment within the
 *   artifacts base: `path.resolve(getArtifactsBase())`.  Any path that
 *   escapes → 403.
 *
 * Response headers:
 *   Content-Type      from `mime_type` (fallback: application/octet-stream)
 *   Content-Length    from `size_bytes`
 *   X-Artifact-SHA256 from `sha256` (Courier verifies integrity)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import {
  authenticateCourier,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/courier-auth';
import { logger } from '@/logger';

// ---------------------------------------------------------------------------
// Artifacts base-directory resolution
// ---------------------------------------------------------------------------

const ARTIFACTS_SUBDIR = 'forge-artifacts';
const DEFAULT_DATA_ROOT = '/data';

/** Reads LOOTGOBLIN_DATA_ROOT env var; defaults to '/data'. */
function getDataRoot(): string {
  const v = process.env.LOOTGOBLIN_DATA_ROOT;
  return v && v.length > 0 ? v : DEFAULT_DATA_ROOT;
}

/** The absolute root under which all forge artifacts live. */
function getArtifactsBase(): string {
  return path.join(getDataRoot(), ARTIFACTS_SUBDIR);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

const ALLOWED_STATUSES = ['claimed', 'dispatched'] as const;

export async function GET(
  req: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;

  // 1. Authenticate — identity from courier_pairing key only.
  const courier = await authenticateCourier(req);
  if (!courier || courier === INVALID_API_KEY) {
    return unauthenticatedResponse(courier as null | typeof INVALID_API_KEY);
  }
  const { agentId } = courier;

  const db = getServerDb();

  // 2. Authorize — job must exist, be claimed/dispatched, and be held by THIS agent.
  const jobRows = await db
    .select({
      status: schema.dispatchJobs.status,
      claimMarker: schema.dispatchJobs.claimMarker,
    })
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, jobId))
    .limit(1);

  const job = jobRows[0];

  if (
    !job ||
    job.claimMarker !== agentId ||
    !ALLOWED_STATUSES.includes(job.status as (typeof ALLOWED_STATUSES)[number])
  ) {
    return Response.json(
      { error: 'forbidden', reason: 'not-claimed-by-agent' },
      { status: 403 },
    );
  }

  // 3. Look up the forge_artifacts row for this job.
  const artifactRows = await db
    .select({
      storagePath: schema.forgeArtifacts.storagePath,
      sizeBytes: schema.forgeArtifacts.sizeBytes,
      sha256: schema.forgeArtifacts.sha256,
      mimeType: schema.forgeArtifacts.mimeType,
    })
    .from(schema.forgeArtifacts)
    .where(eq(schema.forgeArtifacts.dispatchJobId, jobId))
    .limit(1);

  const artifact = artifactRows[0];
  if (!artifact) {
    return Response.json(
      { error: 'not-found', reason: 'no-artifact' },
      { status: 404 },
    );
  }

  // 4. Path-traversal guard.
  //    `storagePath` is an absolute path written by the slicer worker under
  //    `<DATA_ROOT>/forge-artifacts/<jobId>/`.  path.resolve() on an already-
  //    absolute path is a no-op for the path itself, but collapses any `..`
  //    segments that a malicious DB write might inject.
  const artifactsBase = path.resolve(getArtifactsBase());
  const resolvedPath = path.resolve(artifact.storagePath);
  if (
    resolvedPath !== artifactsBase &&
    !resolvedPath.startsWith(artifactsBase + path.sep)
  ) {
    logger.warn(
      { jobId, agentId, storagePath: artifact.storagePath, resolvedPath, artifactsBase },
      'artifact GET: resolved path escapes artifacts base — rejecting',
    );
    return Response.json(
      { error: 'forbidden', reason: 'path-traversal' },
      { status: 403 },
    );
  }

  // 5. Read the file.
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(resolvedPath);
  } catch (err) {
    logger.warn({ jobId, resolvedPath, err }, 'artifact GET: file not readable');
    return Response.json(
      { error: 'not-found', reason: 'file-missing' },
      { status: 404 },
    );
  }

  // 6. Stream the bytes with integrity headers.
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': artifact.mimeType ?? 'application/octet-stream',
      'Content-Length': String(artifact.sizeBytes),
      'X-Artifact-SHA256': artifact.sha256,
    },
  });
}
