// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * POST /api/v1/stash-roots/[id]/adoption/scan
 *
 * Runs phases 1-4 of the Library Adoption flow:
 *   1. Walk filesystem (walkStashRoot)
 *   2. Group files into candidates (groupFilesIntoCandidates)
 *   3. Classify each candidate (Classifier with all rules-based providers)
 *   4. Derive templates from observed folder patterns + starters
 *
 * Caches the resulting proposal in the process-local store and returns
 * the candidate list + derived templates to the client. The client passes
 * back the `proposalId` in subsequent Preview / Apply requests.
 *
 * Auth model:  BetterAuth session OR x-api-key.
 * ACL:         Caller must own the parent stashRoot OR be admin.
 *              Uses kind:'collection' (the resolver has no stash_root kind —
 *              matches the precedent in stash-roots/[id]/route.ts).
 */

import { NextResponse } from 'next/server';
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { authenticateRequest, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { logger } from '@/logger';

import { createAdoptionEngine, type AdoptionProposal as ScanResult } from '@/stash/adoption';
import {
  putProposal,
  type AdoptionProposal as CacheProposal,
} from '@/stash/adoption/proposal-cache';

import { toScanResponseDto } from '../_shared';

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  // Auth
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') {
    return unauthenticatedResponse(authOutcome);
  }
  const user = authOutcome;

  const { id } = await ctx.params;

  // Look up the stash root.
  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.stashRoots)
    .where(eq(schema.stashRoots.id, id))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  const root = rows[0]!; // length guard above proves rows[0] exists

  // ACL — same kind:'collection' workaround as stash-roots/[id]/route.ts.
  // The ACL resolver has no stash_root kind; collection's update policy
  // (owner or admin) matches the required behaviour.
  const acl = resolveAcl({
    user,
    resource: { kind: 'collection', id, ownerId: root.ownerId },
    action: 'update',
  });
  if (!acl.allowed) {
    return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });
  }

  // Verify the stash root path is accessible before handing off to the engine.
  // The walker silently returns [] for ENOENT, but we want to surface that as
  // a 500 so the client knows the scan could not run (path was deleted after
  // the stash root was registered, or is otherwise inaccessible).
  try {
    await fsp.access(root.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, stashRootId: id, path: root.path }, 'adoption scan: stash root path not accessible');
    return NextResponse.json({ error: 'path-not-accessible', reason: message }, { status: 500 });
  }

  // Run phases 1-4 via the AdoptionEngine (avoids duplicating provider wiring).
  let scanResult: ScanResult;
  try {
    const engine = createAdoptionEngine();
    // Note: engine.scan re-fetches the stash root row; accepted as a minor redundant read (idempotent).
    scanResult = await engine.scan(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, stashRootId: id }, 'adoption scan: engine.scan() threw');
    return NextResponse.json({ error: 'scan-failed', reason: message }, { status: 500 });
  }

  // Map orchestrator result → cache shape.
  // The orchestrator's AdoptionProposal has templateOptions + noPatternDetected.
  // The cache shape wants derivedTemplates: { templates, patternDetected }.
  const derivedTemplates = {
    templates: scanResult.templateOptions.map((o) => o.template),
    patternDetected: !scanResult.noPatternDetected,
  };

  const proposalId = crypto.randomUUID();
  const now = new Date();

  const cacheEntry: CacheProposal = {
    id: proposalId,
    userId: user.id,
    stashRootId: id,
    createdAt: now,
    lastAccessedAt: now,
    candidates: scanResult.candidates,
    derivedTemplates,
  };

  putProposal(cacheEntry);

  logger.info(
    {
      proposalId,
      stashRootId: id,
      userId: user.id,
      candidateCount: scanResult.candidates.length,
    },
    'adoption scan: proposal cached',
  );

  return NextResponse.json(
    toScanResponseDto(proposalId, scanResult.candidates, derivedTemplates),
  );
}
