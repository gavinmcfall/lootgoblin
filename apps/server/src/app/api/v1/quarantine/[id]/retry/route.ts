/**
 * POST /api/v1/quarantine/[id]/retry — Quarantine HTTP Layer T5
 *
 * Re-enqueues the underlying ingest_job by cloning the original ingest_jobs row
 * that caused this item to be quarantined, then marks the quarantine item as
 * resolved.
 *
 * Clone strategy
 * ──────────────
 * The original ingest_job that quarantined the item is the source of truth for
 * sourceId, targetKind, targetPayload, collectionId, and ownerId. A fresh row
 * is inserted carrying those values verbatim. Fields NOT copied:
 *   - idempotencyKey  (caller-supplied; not retried)
 *   - failureReason / failureDetails  (cleared for the fresh attempt)
 *   - lootId  (not yet placed)
 *   - parentSubscriptionId  (original lineage stays with the original job)
 *   - quarantineItemId  (null on the new job — it's not quarantined yet)
 *
 * Orphaned quarantine items
 * ─────────────────────────
 * If no original ingest_job is found (quarantineItemId FK was SET NULL before
 * the retry, or the item was created outside the normal pipeline), the route
 * returns 422 {error: 'no-source-job'}. The caller must create a new ingest
 * job from scratch via POST /api/v1/ingest.
 *
 * Auth model
 * ──────────
 * authenticateRequest — BetterAuth session OR x-api-key 'programmatic'.
 *
 * ACL
 * ───
 * owner  → 200 (write access)
 * admin  → 404 for cross-owner write (mirrors Forge consent model)
 * non-owner / non-admin → 404 (hides existence, never 403)
 * unknown id → 404
 *
 * Idempotency
 * ───────────
 * - Already resolved via a previous RETRY → 200 with the existing ingestJobId
 *   (idempotent re-enqueue; no new DB writes).
 * - Already resolved via DISMISS (no quarantine.retried ledger event found) →
 *   409 {error: 'already-dismissed'}.  Dismissal is a terminal user intent;
 *   409 signals that the caller needs to make an explicit choice (e.g. create a
 *   new ingest job from scratch), unlike 200 which implies "safe to repeat".
 */

import { eq, desc, and } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { resolveQuarantineAcl } from '@/acl/quarantine';
import { getServerDb, schema } from '@/db/client';
import {
  persistLedgerEventInTx,
  LedgerValidationError,
  type LedgerTxHandle,
} from '@/stash/ledger';

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

const RetryBodySchema = z
  .object({
    override_classifier_hint: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// POST /api/v1/quarantine/[id]/retry
// ---------------------------------------------------------------------------

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  // Auth
  const authResult = await authenticateRequest(req);
  if (!authResult || authResult === INVALID_API_KEY) {
    return unauthenticatedResponse(authResult as null | typeof INVALID_API_KEY);
  }
  const actor = authResult;

  // Parse + validate body
  let bodyRaw: unknown;
  try {
    bodyRaw = await req.json();
  } catch {
    bodyRaw = {};
  }

  const bodyParse = RetryBodySchema.safeParse(bodyRaw);
  if (!bodyParse.success) {
    return NextResponse.json(
      { error: 'invalid-body', issues: bodyParse.error.issues },
      { status: 400 },
    );
  }
  const body = bodyParse.data;

  // ACL — 'write' action; admin cross-owner writes are denied (returns
  // not-found) to mirror the Forge consent model.
  const acl = await resolveQuarantineAcl(actor, id, 'write');
  if (!acl.allowed) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  const item = acl.item!;

  // Idempotency: item already resolved — determine if it was retried or dismissed.
  if (item.resolvedAt !== null) {
    return handleAlreadyResolved(id);
  }

  // Look up the original ingest_job that quarantined this item.
  const db = getServerDb();
  const originalJobs = await db
    .select()
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.quarantineItemId, id))
    .orderBy(desc(schema.ingestJobs.createdAt))
    .limit(1);

  const originalJob = originalJobs[0] ?? null;

  if (!originalJob) {
    // Orphaned quarantine item — no original ingest_job found. This happens
    // when the FK was SET NULL (original job deleted) before retry, or the
    // item was created outside the normal pipeline. Caller must use
    // POST /api/v1/ingest to create a new job from scratch.
    return NextResponse.json(
      {
        error: 'no-source-job',
        message: 'cannot retry — original ingest job not found',
      },
      { status: 422 },
    );
  }

  // Happy path — atomic transaction.
  const newJobId = randomUUID();
  const now = new Date();

  try {
    const result = (db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction(
      (tx) => {
        const t = tx as ReturnType<typeof getServerDb>;

        // 1. Insert fresh ingest_jobs row cloned from the original.
        t.insert(schema.ingestJobs)
          .values({
            id: newJobId,
            ownerId: originalJob.ownerId,
            sourceId: originalJob.sourceId,
            targetKind: originalJob.targetKind,
            targetPayload: originalJob.targetPayload,
            collectionId: originalJob.collectionId ?? null,
            status: 'queued',
            lootId: null,
            quarantineItemId: null,
            failureReason: null,
            failureDetails: null,
            attempt: 1,
            idempotencyKey: null,
            parentSubscriptionId: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();

        // 2. Mark quarantine item resolved.
        t.update(schema.quarantineItems)
          .set({ resolvedAt: now })
          .where(eq(schema.quarantineItems.id, id))
          .run();

        // 3. Emit ledger event.
        persistLedgerEventInTx(t as LedgerTxHandle, {
          kind: 'quarantine.retried',
          actorUserId: actor.id,
          subjectType: 'quarantine_item',
          subjectId: id,
          relatedResources: [
            { kind: 'ingest_job', id: newJobId, role: 'retry-of' },
            { kind: 'ingest_job', id: originalJob.id, role: 'original' },
          ],
          payload: {
            stashRootId: item.stashRootId,
            reason: item.reason,
            path: item.path,
            newIngestJobId: newJobId,
            originalIngestJobId: originalJob.id,
            ...(body.override_classifier_hint !== undefined && {
              overrideClassifierHint: body.override_classifier_hint,
            }),
          },
          provenanceClass: 'system',
          occurredAt: now,
          ingestedAt: now,
        });

        return newJobId;
      },
    );

    return NextResponse.json({ ok: true, ingestJobId: result });
  } catch (err) {
    if (err instanceof LedgerValidationError) {
      return NextResponse.json(
        { error: 'ledger-validation-failed' },
        { status: 500 },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The item was previously resolved — determine whether it was retried or
 * dismissed so we can return the right idempotency response.
 *
 * Re-retry  → 200 with the existing ingestJobId (safe-to-repeat semantics).
 * Dismissed → 409 (the caller made a different terminal choice; signal it).
 */
async function handleAlreadyResolved(itemId: string): Promise<Response> {
  const db = getServerDb();

  // Look for a prior quarantine.retried ledger event for this item.
  // Filter by kind + subjectType + subjectId to avoid an in-memory scan.
  const retriedEvents = await db
    .select()
    .from(schema.ledgerEvents)
    .where(
      and(
        eq(schema.ledgerEvents.subjectId, itemId),
        eq(schema.ledgerEvents.kind, 'quarantine.retried'),
        eq(schema.ledgerEvents.subjectType, 'quarantine_item'),
      ),
    )
    .limit(1);

  const retriedEvent = retriedEvents[0] ?? null;

  if (retriedEvent) {
    // Was retried before — extract the ingestJobId from relatedResources.
    const related = retriedEvent.relatedResources as Array<{
      kind: string;
      id: string;
      role: string;
    }> | null;
    const jobRef = related?.find((r) => r.kind === 'ingest_job' && r.role === 'retry-of');
    return NextResponse.json({
      ok: true,
      ingestJobId: jobRef?.id ?? null,
    });
  }

  // No retry event found — item was dismissed via DELETE.
  return NextResponse.json(
    { ok: false, error: 'already-dismissed' },
    { status: 409 },
  );
}
