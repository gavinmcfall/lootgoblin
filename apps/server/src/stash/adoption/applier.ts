/**
 * applier.ts — Applies an AdoptionPlan to a stash root.
 *
 * in-place mode:
 *   1. Create Collection (once per adoption — all Loots land in the same Collection).
 *   2. For each chosen candidate: insert loot + lootFiles rows at existing paths
 *      (no filesystem mutation).
 *
 * copy-then-cleanup mode:
 *   1. Same as in-place but additionally MOVE files via T3 linkOrCopy to
 *      template-resolved paths.
 *   2. Move happens BEFORE DB insert — the onAfterDestinationVerified hook
 *      inserts rows inside the same logical window.
 *   3. Cleanup policy: immediate (source removed after successful move + DB insert).
 *   4. If any file move fails, skip that candidate, add to errors[], continue.
 *
 * In both modes, the Collection is created first. If Collection creation fails,
 * the whole apply fails.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { logger } from '../../logger';
import { getDb, schema } from '../../db/client';
import { linkOrCopy } from '../filesystem-adapter';
import { parseTemplate, resolveTemplate } from '../path-template';
import type { AdoptionPlan, AdoptionReport, AdoptionCandidate } from '../adoption';

// ---------------------------------------------------------------------------
// applyAdoptionPlan
// ---------------------------------------------------------------------------

/**
 * Applies an AdoptionPlan and returns an AdoptionReport.
 *
 * @param plan The adoption plan from the user.
 * @param candidates All candidates from the AdoptionProposal (used for lookup by ID).
 * @param stashRootPath Absolute filesystem path of the stash root.
 * @param ownerId The BetterAuth user ID who owns this stash root.
 * @param dbUrl Optional DATABASE_URL override (used in tests).
 */
export async function applyAdoptionPlan(
  plan: AdoptionPlan,
  candidates: AdoptionCandidate[],
  stashRootPath: string,
  ownerId: string,
  dbUrl?: string,
): Promise<AdoptionReport> {
  const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  const appliedAt = new Date();

  const report: AdoptionReport = {
    stashRootId: plan.stashRootId,
    appliedAt,
    mode: plan.mode,
    chosenTemplate: plan.chosenTemplate,
    lootsCreated: 0,
    lootFilesCreated: 0,
    skippedCandidates: [],
    errors: [],
  };

  // Parse the template once — fail fast if malformed.
  let parsed: ReturnType<typeof parseTemplate>;
  try {
    parsed = parseTemplate(plan.chosenTemplate);
  } catch (err) {
    throw new Error(`Invalid template "${plan.chosenTemplate}": ${(err as Error).message}`);
  }

  // Look up the chosen candidates.
  const candidateMap = new Map<string, AdoptionCandidate>(
    candidates.map((c) => [c.id, c]),
  );

  // ── 1. Create Collection ───────────────────────────────────────────────────
  const collectionId = crypto.randomUUID();
  const collectionName =
    plan.collectionName ??
    `Adopted: ${path.basename(stashRootPath)} — ${appliedAt.toISOString()}`;

  try {
    await db.insert(schema.collections).values({
      id: collectionId,
      ownerId,
      name: collectionName,
      pathTemplate: plan.chosenTemplate,
      stashRootId: plan.stashRootId,
      createdAt: appliedAt,
      updatedAt: appliedAt,
    });
  } catch (err) {
    throw new Error(
      `Failed to create Collection for adoption: ${(err as Error).message}`,
    );
  }

  logger.info(
    { collectionId, mode: plan.mode, candidateCount: plan.candidateIds.length },
    'adoption: collection created, beginning candidate processing',
  );

  // Track resolved paths to detect collisions at apply time.
  const resolvedPaths = new Map<string, string>(); // resolvedPath → candidateId

  // ── 2. Process each candidate ─────────────────────────────────────────────
  for (const candidateId of plan.candidateIds) {
    const candidate = candidateMap.get(candidateId);
    if (!candidate) {
      report.skippedCandidates.push({
        candidateId,
        reason: `Candidate ${candidateId} not found in proposal`,
      });
      continue;
    }

    // Build metadata for template resolution — include user-supplied fields.
    const metadata = buildMetadata(candidate, plan.confirmFieldsUserSupplied?.[candidateId]);

    // Check needsUserInput fields are satisfied.
    const unresolved = candidate.classification.needsUserInput.filter(
      (field) => metadata[field] === undefined,
    );
    if (unresolved.length > 0) {
      report.skippedCandidates.push({
        candidateId,
        reason: `Missing required fields: ${unresolved.join(', ')}`,
      });
      continue;
    }

    // Resolve the template to get the destination path.
    const verdict = resolveTemplate(parsed, { metadata, targetOS: 'linux' });
    if (!verdict.ok) {
      report.skippedCandidates.push({
        candidateId,
        reason: `Template resolution failed: ${verdict.reason} — ${verdict.details}`,
      });
      continue;
    }

    const resolvedPath = verdict.path;

    // Check for collision with a previously-processed candidate.
    const existingId = resolvedPaths.get(resolvedPath);
    if (existingId !== undefined) {
      report.skippedCandidates.push({
        candidateId,
        reason: `Collision: path "${resolvedPath}" already claimed by candidate ${existingId}`,
      });
      continue;
    }
    resolvedPaths.set(resolvedPath, candidateId);

    // Process based on mode.
    if (plan.mode === 'in-place') {
      await applyInPlace(
        candidate,
        metadata,
        collectionId,
        ownerId,
        db,
        appliedAt,
        report,
      );
    } else {
      await applyCopyThenCleanup(
        candidate,
        metadata,
        collectionId,
        ownerId,
        stashRootPath,
        resolvedPath,
        db,
        appliedAt,
        report,
      );
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// in-place mode
// ---------------------------------------------------------------------------

async function applyInPlace(
  candidate: AdoptionCandidate,
  metadata: Record<string, unknown>,
  collectionId: string,
  ownerId: string,
  db: ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>,
  now: Date,
  report: AdoptionReport,
): Promise<void> {
  const lootId = crypto.randomUUID();

  // Use effective metadata (includes user-supplied overrides) for the loot row.
  const effectiveTitle =
    (metadata['title'] as string | undefined) ??
    candidate.classification.title?.value ??
    candidate.folderRelativePath;
  const effectiveCreator =
    (metadata['creator'] as string | undefined) ??
    candidate.classification.creator?.value ??
    null;
  const effectiveDescription =
    (metadata['description'] as string | undefined) ??
    candidate.classification.description?.value ??
    null;
  const effectiveLicense =
    (metadata['license'] as string | undefined) ??
    candidate.classification.license?.value ??
    null;
  const effectiveTags = candidate.classification.tags?.value ?? [];

  try {
    await db.insert(schema.loot).values({
      id: lootId,
      collectionId,
      title: effectiveTitle,
      description: effectiveDescription,
      tags: effectiveTags,
      creator: effectiveCreator,
      license: effectiveLicense,
      sourceItemId: null,
      contentSummary: null,
      fileMissing: false,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    report.errors.push({
      candidateId: candidate.id,
      error: `Failed to insert loot row: ${(err as Error).message}`,
    });
    return;
  }

  let fileCount = 0;
  for (const file of candidate.files) {
    const fileId = crypto.randomUUID();
    let hash: string;
    try {
      hash = await sha256Hex(file.absolutePath);
    } catch {
      hash = '0000000000000000000000000000000000000000000000000000000000000000';
    }
    const ext = path.extname(file.relativePath).slice(1).toLowerCase() || 'bin';

    try {
      await db.insert(schema.lootFiles).values({
        id: fileId,
        lootId,
        path: file.relativePath, // relative to stash root (invariant)
        format: ext,
        size: file.size,
        hash,
        origin: 'adoption',
        provenance: null,
        createdAt: now,
      });
      fileCount++;
    } catch (err) {
      logger.warn(
        { candidateId: candidate.id, file: file.relativePath, err },
        'adoption: failed to insert lootFile row (in-place)',
      );
    }
  }

  report.lootsCreated++;
  report.lootFilesCreated += fileCount;
}

// ---------------------------------------------------------------------------
// copy-then-cleanup mode
// ---------------------------------------------------------------------------

async function applyCopyThenCleanup(
  candidate: AdoptionCandidate,
  metadata: Record<string, unknown>,
  collectionId: string,
  ownerId: string,
  stashRootPath: string,
  resolvedPath: string, // template-resolved relative path
  db: ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>,
  now: Date,
  report: AdoptionReport,
): Promise<void> {
  // ── Phase 1: Insert loot row FIRST (FK parent for lootFiles). ─────────────
  //
  // If loot insert fails, no files have moved yet — source files intact,
  // no destination created, no DB rows leaked. Clean early-exit.
  //
  // Use effective metadata (user-supplied overrides) for the loot row.
  const effectiveTitle =
    (metadata['title'] as string | undefined) ??
    candidate.classification.title?.value ??
    candidate.folderRelativePath;
  const effectiveCreator =
    (metadata['creator'] as string | undefined) ??
    candidate.classification.creator?.value ??
    null;
  const effectiveDescription =
    (metadata['description'] as string | undefined) ??
    candidate.classification.description?.value ??
    null;
  const effectiveLicense =
    (metadata['license'] as string | undefined) ??
    candidate.classification.license?.value ??
    null;
  const effectiveTags = candidate.classification.tags?.value ?? [];

  const lootId = crypto.randomUUID();

  try {
    await db.insert(schema.loot).values({
      id: lootId,
      collectionId,
      title: effectiveTitle,
      description: effectiveDescription,
      tags: effectiveTags,
      creator: effectiveCreator,
      license: effectiveLicense,
      sourceItemId: null,
      contentSummary: null,
      fileMissing: false,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    report.errors.push({
      candidateId: candidate.id,
      error: `Failed to insert loot row: ${(err as Error).message}`,
    });
    return;
  }

  // ── Phase 2: Per-file linkOrCopy with lootFile insert INSIDE the hook. ────
  //
  // This is the critical transactional-safety step. The T3 FS adapter calls
  // onAfterDestinationVerified() AFTER destination is verified but BEFORE
  // source is unlinked. If the hook throws, the adapter rolls back the
  // destination and leaves the source intact — so a DB insert failure
  // never leaves a file moved with no DB record tracking it.
  //
  // Partial-candidate note: if a later file fails mid-candidate, earlier
  // files in the same candidate have already been moved + have their
  // lootFile rows. The loot row is retained. Other candidates in the plan
  // continue to be processed. This is intentional: per-file transactional
  // safety is the strongest guarantee we can make without wrapping the
  // entire candidate in a cross-filesystem distributed transaction.
  let fileCount = 0;
  let perFileError: string | null = null;

  for (const file of candidate.files) {
    const filename = path.basename(file.relativePath);
    const newRelativePath = `${resolvedPath}/${filename}`;
    const destination = path.join(stashRootPath, newRelativePath);

    const moveResult = await linkOrCopy({
      source: file.absolutePath,
      destination,
      cleanupPolicy: 'immediate',
      // The hook runs after destination verification, before source unlink.
      // If it throws, the adapter:
      //   (a) removes the destination (rollback),
      //   (b) leaves the source intact,
      //   (c) returns status 'failed' with reason 'db-commit-failed'.
      // Thus any throw inside here surfaces as a failed moveResult, not a
      // data-loss window.
      onAfterDestinationVerified: async () => {
        // Compute hash of destination (verified but not yet unlinked).
        // Best-effort: if hashing fails, use zero-hash (matches in-place
        // mode's fallback). The move is still transactional.
        let hash: string;
        try {
          hash = await sha256Hex(destination);
        } catch {
          hash = '0000000000000000000000000000000000000000000000000000000000000000';
        }

        const fileId = crypto.randomUUID();
        const ext = path.extname(newRelativePath).slice(1).toLowerCase() || 'bin';

        // This throw propagates up into linkOrCopy, triggering rollback.
        // Do NOT try/catch here.
        await db.insert(schema.lootFiles).values({
          id: fileId,
          lootId,
          path: newRelativePath,
          format: ext,
          size: file.size,
          hash,
          origin: 'adoption',
          provenance: null,
          createdAt: now,
        });
      },
    });

    if (moveResult.status === 'failed') {
      // linkOrCopy failed at any step (source-not-found, destination-exists,
      // mkdir-failed, link/copy-failed, hash-mismatch, db-commit-failed,
      // source-cleanup-failed). Adapter has already rolled back destination
      // if applicable. Stop processing this candidate's remaining files.
      const reason =
        moveResult.reason === 'db-commit-failed'
          ? `lootFile insert failed (destination rolled back): ${String((moveResult.error as Error | undefined)?.message ?? 'unknown')}`
          : `${moveResult.reason}: ${moveResult.details}`;
      logger.warn(
        { candidateId: candidate.id, file: file.relativePath, reason: moveResult.reason, rollbackError: moveResult.rollbackError },
        'adoption: file move failed in copy-then-cleanup mode',
      );
      perFileError = reason;
      break;
    }

    fileCount++;
  }

  if (perFileError !== null) {
    report.errors.push({
      candidateId: candidate.id,
      error: `Partial candidate — ${fileCount} of ${candidate.files.length} files moved before failure: ${perFileError}`,
    });
    // Don't decrement lootsCreated — loot row is real, some files are too.
    // The partial state is visible to the user via the error report.
  }

  report.lootsCreated++;
  report.lootFilesCreated += fileCount;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a metadata record for template resolution from a candidate's
 * classification, optionally merging user-supplied field overrides.
 */
function buildMetadata(
  candidate: AdoptionCandidate,
  userSupplied?: Record<string, string>,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  if (candidate.classification.title?.value !== undefined) {
    meta['title'] = candidate.classification.title.value;
  }
  if (candidate.classification.creator?.value !== undefined) {
    meta['creator'] = candidate.classification.creator.value;
  }
  if (candidate.classification.description?.value !== undefined) {
    meta['description'] = candidate.classification.description.value;
  }
  if (candidate.classification.license?.value !== undefined) {
    meta['license'] = candidate.classification.license.value;
  }
  if (candidate.classification.tags?.value !== undefined) {
    meta['tags'] = candidate.classification.tags.value;
  }
  if (candidate.classification.primaryFormat?.value !== undefined) {
    meta['primaryFormat'] = candidate.classification.primaryFormat.value;
  }

  // Apply user-supplied overrides (highest precedence).
  if (userSupplied) {
    for (const [key, value] of Object.entries(userSupplied)) {
      meta[key] = value;
    }
  }

  return meta;
}

/**
 * Streams a file through SHA-256 and returns the hex digest.
 */
async function sha256Hex(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await pipeline(stream, async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
    }
  });
  return hash.digest('hex');
}
