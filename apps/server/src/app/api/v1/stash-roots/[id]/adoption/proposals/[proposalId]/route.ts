// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * GET + DELETE /api/v1/stash-roots/[id]/adoption/proposals/[proposalId]
 *
 * GET  — Re-fetches a cached proposal and returns it in ScanResponseDto shape.
 *         Defensive read for canvases that need to recover mid-wizard state.
 *
 * DELETE — Cancels (discards) a proposal.  Useful when the user abandons the
 *           adoption wizard before reaching Apply.  Returns {ok:true} on
 *           success; 404 if the proposal is already gone.
 *
 * Both handlers share the same ACL: caller must own the stash root [id] OR be
 * admin.  A missing / wrong-owner / wrong-stash-root proposalId is always 404
 * (hide-existence) regardless of which condition triggered the miss.
 *
 * Auth model:  BetterAuth session OR x-api-key.
 * ACL:         kind:'collection' workaround — same as scan/preview/apply routes.
 *              The ACL resolver has no stash_root kind; collection's 'update'
 *              policy (owner or admin) matches the required behaviour.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { authenticateRequest, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';

import {
  getProposal,
  deleteProposal,
} from '@/stash/adoption/proposal-cache';

import { toScanResponseDto } from '../../_shared';

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string; proposalId: string }> },
) {
  // Auth
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') {
    return unauthenticatedResponse(authOutcome);
  }
  const user = authOutcome;

  const { id, proposalId } = await context.params;

  // Look up the stash root to obtain the ownerId for ACL evaluation.
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

  // ACL — same kind:'collection' workaround as scan/preview/apply routes.
  const acl = resolveAcl({
    user,
    resource: { kind: 'collection', id, ownerId: root.ownerId },
    action: 'update',
  });
  if (!acl.allowed) {
    return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });
  }

  // Resolve proposal — returns null for unknown id, wrong user, or wrong
  // stash root. All three are indistinguishable to the caller (hide existence).
  const proposal = getProposal(proposalId, user.id, id);
  if (!proposal) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  // getProposal bumps lastAccessedAt (sliding TTL), so recompute expiresAt
  // from now — same behaviour as scan/route.ts. toScanResponseDto calls
  // `Date.now() + PROPOSAL_TTL_MS` internally, which gives the correct
  // post-bump expiry.
  return NextResponse.json(
    toScanResponseDto(proposal.id, proposal.candidates, proposal.derivedTemplates),
  );
}

// ---------------------------------------------------------------------------
// DELETE handler (cancel)
// ---------------------------------------------------------------------------

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string; proposalId: string }> },
) {
  // Auth
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') {
    return unauthenticatedResponse(authOutcome);
  }
  const user = authOutcome;

  const { id, proposalId } = await context.params;

  // Look up the stash root to obtain the ownerId for ACL evaluation.
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

  // ACL — same kind:'collection' workaround.
  const acl = resolveAcl({
    user,
    resource: { kind: 'collection', id, ownerId: root.ownerId },
    action: 'update',
  });
  if (!acl.allowed) {
    return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });
  }

  // Check existence before deleting — cancelling an unknown / foreign proposal
  // is 404, not a silent 200. Also ensures a second DELETE of the same
  // proposalId returns 404 (idempotency: once it's gone, it's gone).
  const proposal = getProposal(proposalId, user.id, id);
  if (!proposal) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  deleteProposal(proposalId);

  // 200 {ok:true} — matches the DELETE convention used by stash-roots/[id]/route.ts
  // and other resource-clearing mutations in this codebase.
  return NextResponse.json({ ok: true });
}
