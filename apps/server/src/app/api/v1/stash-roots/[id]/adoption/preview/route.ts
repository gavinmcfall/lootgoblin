/**
 * POST /api/v1/stash-roots/[id]/adoption/preview
 *
 * Re-runs `buildTemplateOptions` against a cached proposal with:
 *   - A (possibly subset) candidate selection via `selectedCandidateIds`.
 *   - A caller-supplied template list.
 *
 * Used by the wizard's "tweak template + see collisions" step.
 * This is a read-only operation — the proposal cache entry is NOT mutated
 * beyond the expected `lastAccessedAt` TTL bump from `getProposal`.
 *
 * Auth model:  BetterAuth session OR x-api-key.
 * ACL:         Caller must own the parent stashRoot OR be admin.
 *              Uses kind:'collection' (same workaround as scan/route.ts).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { authenticateRequest, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { logger } from '@/logger';

import { buildTemplateOptions } from '@/stash/adoption/preview';
import { getProposal } from '@/stash/adoption/proposal-cache';

import { toPreviewResponseDto } from '../_shared';

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

const PreviewBody = z
  .object({
    proposalId: z.string().uuid(),
    templates: z.array(z.string().min(1)).min(1).max(10),
    selectedCandidateIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

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

  const root = rows[0]!;

  // ACL — same kind:'collection' workaround as scan/route.ts.
  const acl = resolveAcl({
    user,
    resource: { kind: 'collection', id, ownerId: root.ownerId },
    action: 'update',
  });
  if (!acl.allowed) {
    return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });
  }

  // Parse + validate body.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-body', reason: 'JSON parse error' }, { status: 400 });
  }

  const parsed = PreviewBody.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', reason: parsed.error.issues },
      { status: 400 },
    );
  }

  const { proposalId, templates, selectedCandidateIds } = parsed.data;

  // Resolve proposal — returns null for unknown id, wrong user, or wrong stash root.
  // All three conditions are indistinguishable to the caller (hide-existence policy).
  const proposal = getProposal(proposalId, user.id, id);
  if (!proposal) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  // Filter candidates.
  // If selectedCandidateIds is omitted → use all candidates.
  // If provided → keep only those that match a known candidate id.
  // Unknown ids in the selection are silently ignored (subset semantics).
  const candidates =
    selectedCandidateIds === undefined
      ? proposal.candidates
      : proposal.candidates.filter((c) => selectedCandidateIds.includes(c.id));

  // Build template options (pure — no side effects).
  const options = buildTemplateOptions(templates, candidates);

  logger.info(
    {
      proposalId,
      stashRootId: id,
      userId: user.id,
      templateCount: templates.length,
      candidateCount: candidates.length,
      optionCount: options.length,
    },
    'adoption preview: template options computed',
  );

  return NextResponse.json(toPreviewResponseDto(options));
}
