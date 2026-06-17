// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * POST /api/v1/stash-roots/[id]/adoption/apply
 *
 * The consequential step of the Library Adoption flow. Consumes a cached
 * proposal, materializes the selected candidates as Loot rows under a new
 * Collection, emits an `adoption.applied` ledger event, and deletes the
 * proposal from the cache on success.
 *
 * Logic
 * ─────
 *   1. Auth + ACL (caller must own the parent stashRoot OR be admin).
 *   2. Parse + validate body.
 *   3. Load the cached proposal (404 if unknown / wrong user / wrong root).
 *   4. Filter candidates to `selectedCandidateIds`. Any id that doesn't match
 *      a cached candidate is a client error → 400 invalid-candidate-ids.
 *   5. Build the AdoptionPlan and run `applyAdoptionPlan` directly with the
 *      cached, filtered candidates. (We do NOT use `engine.apply`: that path
 *      re-walks the filesystem, which would discard the cache and ignore the
 *      `selectedCandidateIds` selection.)
 *   6. Read the created `collectionId` straight off `report.collectionId` —
 *      the applier generates it internally and surfaces it on the report.
 *   7. Emit the `adoption.applied` ledger event via `persistLedgerEvent` (the
 *      fire-and-continue async variant). The applier already committed the
 *      Loot + Collection rows; a ledger-emit failure is a non-fatal audit gap,
 *      not a reason to 500 the user — `persistLedgerEvent` never throws.
 *   8. `deleteProposal` — ONLY on success. If `applyAdoptionPlan` throws, the
 *      proposal is left intact so the user can retry.
 *   9. Return `ApplyReportDto`.
 *
 * Idempotency: applying the same `proposalId` twice yields a 404 on the second
 * call (the proposal was consumed on the first success). No separate
 * idempotency layer — that 404 is the intended signal.
 *
 * Auth model:  BetterAuth session OR x-api-key.
 * ACL:         Caller must own the parent stashRoot OR be admin.
 *              Uses kind:'collection' (same workaround as scan/route.ts —
 *              the ACL resolver has no stash_root kind).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { authenticateRequest, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { logger } from '@/logger';

import { applyAdoptionPlan } from '@/stash/adoption/applier';
import type { AdoptionPlan, AdoptionReport } from '@/stash/adoption';
import { getProposal, deleteProposal } from '@/stash/adoption/proposal-cache';
import { persistLedgerEvent } from '@/stash/ledger';

import { toApplyReportDto } from '../_shared';

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

const ApplyBody = z
  .object({
    proposalId: z.string().uuid(),
    template: z.string().min(1),
    selectedCandidateIds: z.array(z.string().uuid()).min(1),
    mode: z.enum(['in-place', 'copy-then-cleanup']),
    collectionName: z.string().min(1).max(200),
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

  const parsed = ApplyBody.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', reason: parsed.error.issues },
      { status: 400 },
    );
  }

  const { proposalId, template, selectedCandidateIds, mode, collectionName } = parsed.data;

  // Resolve proposal — returns null for unknown id, wrong user, or wrong stash
  // root. All three conditions are indistinguishable to the caller.
  const proposal = getProposal(proposalId, user.id, id);
  if (!proposal) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  // Filter candidates to the selection. Unlike preview (which silently ignores
  // unknown ids as subset semantics), apply is consequential — an id that
  // doesn't match a cached candidate is a client error.
  const candidateMap = new Map(proposal.candidates.map((c) => [c.id, c]));
  const unmatchedIds = selectedCandidateIds.filter((cid) => !candidateMap.has(cid));
  if (unmatchedIds.length > 0) {
    return NextResponse.json(
      { error: 'invalid-candidate-ids', detail: unmatchedIds },
      { status: 400 },
    );
  }
  const filteredCandidates = selectedCandidateIds.map((cid) => candidateMap.get(cid)!);

  // Build the AdoptionPlan.
  const plan: AdoptionPlan = {
    stashRootId: id,
    chosenTemplate: template,
    mode,
    candidateIds: selectedCandidateIds,
    collectionName,
  };

  // Run the applier directly with the cached, filtered candidates.
  let report: AdoptionReport;
  try {
    report = await applyAdoptionPlan(plan, filteredCandidates, root.path, root.ownerId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, proposalId, stashRootId: id }, 'adoption apply: applyAdoptionPlan threw');
    // Proposal is intentionally NOT deleted — the user can retry.
    return NextResponse.json({ error: 'apply-failed', reason: message }, { status: 500 });
  }

  // The applier always creates exactly one Collection before it can return a
  // report (it throws on creation failure), so report.collectionId is the
  // authoritative id of the row that was just committed.
  const collectionId = report.collectionId;

  // Emit the ledger event. persistLedgerEvent is fire-and-continue — it never
  // throws. The Loot + Collection rows are already committed; a failed audit
  // row is a non-fatal inconsistency, logged but not surfaced as a 500.
  const ledgerResult = await persistLedgerEvent({
    kind: 'adoption.applied',
    actorUserId: user.id,
    subjectType: 'collection',
    subjectId: collectionId,
    payload: {
      adoptedCount: report.lootsCreated,
      skippedCount: report.skippedCandidates.length,
      errorCount: report.errors.length,
      mode: report.mode,
      template: report.chosenTemplate,
    },
    provenanceClass: 'system',
  });
  if (ledgerResult.eventId === null) {
    logger.warn(
      { proposalId, stashRootId: id, collectionId },
      'adoption apply: ledger event emit failed — adoption succeeded, audit row missing',
    );
  }

  // Consume the proposal — ONLY reached on a successful apply.
  deleteProposal(proposalId);

  logger.info(
    {
      proposalId,
      stashRootId: id,
      userId: user.id,
      collectionId,
      adoptedCount: report.lootsCreated,
      skippedCount: report.skippedCandidates.length,
      errorCount: report.errors.length,
      mode,
    },
    'adoption apply: plan applied, proposal consumed',
  );

  return NextResponse.json(toApplyReportDto(report, collectionId));
}
