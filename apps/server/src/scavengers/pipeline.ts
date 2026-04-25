/**
 * pipeline.ts — Shared Ingest Pipeline (V2-003-T2)
 *
 * Consumes an AsyncIterable<ScavengerEvent> from any ScavengerAdapter.
 * On `completed`: validate → hash → dedup → quarantine OR place.
 * Manages the staging-dir lifecycle (create on entry, clean up in finally).
 *
 * Algorithm:
 *   1. Create ingest_jobs row (status='queued').
 *   2. Create staging dir at ${stagingRoot}/${jobId}/.
 *   3. Update job → status='fetching'.
 *   4. Drive adapter.fetch() event loop.
 *   5. On completed: validate file sizes + formats, hash all files.
 *   6. Dedup by primary-file hash + by (sourceId, sourceItemId).
 *   7. New loot: update job → status='placing', call applySingleCandidate.
 *   8. On any quarantine condition: insert quarantine_items row, update job.
 *   9. Staging cleanup in finally.
 */

import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { eq, and } from 'drizzle-orm';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { encrypt } from '../crypto';
import { sha256Hex } from '../stash/hash-util';
import { applySingleCandidate } from '../stash/adoption/applier';
import { sniffFormat, DEFAULT_ACCEPTED_FORMATS } from './format-sniff';
import type { ScavengerAdapter, FetchTarget, NormalizedItem } from './types';
import type { AdoptionCandidate } from '../stash/adoption';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type QuarantineReason =
  | 'format-unsupported'
  | 'size-exceeds-limit'
  | 'hash-mismatch'
  | 'placement-failed'
  | 'validation-failed';

export type IngestOutcome =
  | { status: 'placed'; jobId: string; lootId: string; deduped: boolean }
  | { status: 'quarantined'; jobId: string; quarantineItemId: string; reason: QuarantineReason }
  | {
      status: 'failed';
      jobId: string;
      reason: import('./types').AdapterFailureReason;
      details: string;
    }
  | {
      status: 'paused-auth';
      jobId: string;
      reason: 'expired' | 'revoked' | 'missing' | 'rate-limited-backoff';
    };

export type IngestOptions = {
  /** Owner of the job (user id). Required for ACL + ingest_jobs row. */
  ownerId: string;
  /** Collection the Loot should land in. Required — adapters don't pick Collections. */
  collectionId: string;
  /** Per-file size cap in bytes. Default 2 GB. */
  maxFileSize?: number;
  /** Accepted formats (lowercase, no dot). Defaults to DEFAULT_ACCEPTED_FORMATS. */
  acceptedFormats?: string[];
  /**
   * Pipeline-level ceiling on `rate-limited` events before giving up.
   * Defense against a misbehaving adapter that emits `rate-limited` forever.
   * Default 50.
   */
  maxAttempts?: number;
  /** Injected DB clock for deterministic tests. Defaults to () => new Date(). */
  now?: () => Date;
  /** Where to stage adapter-downloaded files. Defaults to /tmp/lootgoblin-ingest/. */
  stagingRoot?: string;
  /** Optional DATABASE_URL override (used in tests). */
  dbUrl?: string;
};

export interface IngestPipeline {
  /** Run the full pipeline for a single target. Creates ingest_jobs row, invokes adapter, handles outcome. */
  run(args: {
    adapter: ScavengerAdapter;
    target: FetchTarget;
    credentials?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<IngestOutcome>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const DEFAULT_STAGING_ROOT = '/tmp/lootgoblin-ingest';
const DEFAULT_MAX_ATTEMPTS = 50;

export function createIngestPipeline(options: IngestOptions): IngestPipeline {
  const {
    ownerId,
    collectionId,
    maxFileSize = DEFAULT_MAX_FILE_SIZE,
    acceptedFormats = DEFAULT_ACCEPTED_FORMATS as string[],
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    now = () => new Date(),
    stagingRoot = DEFAULT_STAGING_ROOT,
    dbUrl,
  } = options;

  function db() {
    return getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  }

  return {
    async run({ adapter, target, credentials, signal }) {
      const jobId = crypto.randomUUID();
      const createdAt = now();

      // ── 1. Create ingest_jobs row ─────────────────────────────────────────
      await db().insert(schema.ingestJobs).values({
        id: jobId,
        ownerId,
        sourceId: adapter.id,
        targetKind: target.kind,
        targetPayload: JSON.stringify(target),
        collectionId,
        status: 'queued',
        lootId: null,
        quarantineItemId: null,
        failureReason: null,
        failureDetails: null,
        attempt: 1,
        createdAt,
        updatedAt: createdAt,
      });

      // ── 2. Create staging dir (inside try so mkdir failures are caught) ───
      const stagingDir = path.join(stagingRoot, jobId);

      try {
        await fsp.mkdir(stagingDir, { recursive: true });

        // ── 3. Update job → fetching ────────────────────────────────────────
        await safeUpdateJob(db, jobId, { status: 'fetching', updatedAt: now() });

        // ── 4. Drive adapter event loop ─────────────────────────────────────
        //
        // onTokenRefreshed: when the adapter refreshes an OAuth token (or any
        // other credential bag), we persist the new bag back to source_credentials
        // so subsequent fetches use the fresh access token instead of triggering
        // another refresh round-trip. Errors here MUST NOT propagate — adapters
        // already received the refreshed bag in-memory and the request will
        // succeed; persistence is best-effort.
        //
        // Lookup model: source_credentials is keyed by sourceId (no per-user
        // column in the existing schema). We update the most-recent active row
        // for the given sourceId. If no row is present (rare race — credential
        // was deleted between fetch start and refresh), we log warn + skip.
        const fetchCtx = {
          userId: ownerId,
          credentials,
          stagingDir,
          signal,
          onTokenRefreshed: async (newCredentials: Record<string, unknown>) => {
            try {
              const secret = process.env.LOOTGOBLIN_SECRET;
              if (!secret) {
                logger.warn(
                  { jobId, sourceId: adapter.id },
                  'ingest: LOOTGOBLIN_SECRET unset — skipping refreshed-credential persistence',
                );
                return;
              }
              const rows = await db()
                .select({ id: schema.sourceCredentials.id })
                .from(schema.sourceCredentials)
                .where(eq(schema.sourceCredentials.sourceId, adapter.id))
                .limit(1);
              const row = rows[0];
              if (!row) {
                logger.warn(
                  { jobId, sourceId: adapter.id },
                  'ingest: no source_credentials row to persist refreshed credentials — skipping',
                );
                return;
              }
              const blob = JSON.stringify(newCredentials);
              const encrypted = encrypt(blob, secret);
              await db()
                .update(schema.sourceCredentials)
                .set({
                  encryptedBlob: Buffer.from(encrypted),
                  lastUsedAt: now(),
                })
                .where(eq(schema.sourceCredentials.id, row.id));
            } catch (err) {
              logger.warn(
                { jobId, sourceId: adapter.id, err },
                'ingest: failed to persist refreshed credentials (non-fatal)',
              );
            }
          },
        };

        let completedItem: NormalizedItem | null = null;
        let attempt = 1;

        for await (const evt of adapter.fetch(fetchCtx, target)) {
          if (evt.kind === 'progress') {
            logger.info(
              { jobId, message: evt.message, completedBytes: evt.completedBytes, totalBytes: evt.totalBytes },
              'ingest: progress',
            );
          } else if (evt.kind === 'rate-limited') {
            attempt = evt.attempt;
            // Pipeline-level ceiling: defense against an adapter that loops
            // forever emitting rate-limited events. The adapter's own
            // rate-limit helper has a per-attempt ceiling; this is the
            // belt-and-braces safeguard at the pipeline layer.
            if (attempt > maxAttempts) {
              const details = `Exceeded ${maxAttempts} rate-limited events — adapter loop detected`;
              await safeUpdateJob(db, jobId, {
                status: 'failed',
                failureReason: 'rate-limit-exhausted',
                failureDetails: details,
                attempt,
                updatedAt: now(),
              });
              return { status: 'failed', jobId, reason: 'rate-limit-exhausted', details };
            }
            logger.info(
              { jobId, retryAfterMs: evt.retryAfterMs, attempt: evt.attempt },
              'ingest: rate-limited — adapter backing off',
            );
            await safeUpdateJob(db, jobId, { attempt, updatedAt: now() });
          } else if (evt.kind === 'auth-required') {
            await safeUpdateJob(db, jobId, {
              status: 'paused-auth',
              failureReason: evt.reason,
              updatedAt: now(),
            });
            return { status: 'paused-auth', jobId, reason: evt.reason };
          } else if (evt.kind === 'failed') {
            await safeUpdateJob(db, jobId, {
              status: 'failed',
              failureReason: evt.reason,
              failureDetails: evt.details,
              updatedAt: now(),
            });
            return { status: 'failed', jobId, reason: evt.reason, details: evt.details };
          } else if (evt.kind === 'completed') {
            completedItem = evt.item;
            break;
          }
        }

        if (completedItem === null) {
          // Adapter ended the iterable without a completed/failed event — treat as failure.
          const details = 'Adapter terminated without completed or failed event';
          await safeUpdateJob(db, jobId, {
            status: 'failed',
            failureReason: 'unknown',
            failureDetails: details,
            updatedAt: now(),
          });
          return { status: 'failed', jobId, reason: 'unknown', details };
        }

        // ── 5. Post-completion validation ────────────────────────────────────
        const item = completedItem;

        // Guard against a misbehaving adapter that emits `completed` with zero
        // files. Without this, the validation loop is a no-op and the dedup
        // step below computes a sentinel "null hash" that would dedup against
        // prior zero-file items sharing the same sentinel.
        if (item.files.length === 0) {
          const details = 'Adapter emitted completed with empty files array';
          const qi = await safeCreateQuarantineItem(
            db,
            collectionId,
            stagingDir,
            'validation-failed',
            details,
            now(),
          );
          await safeUpdateJob(db, jobId, {
            status: 'quarantined',
            quarantineItemId: qi ?? null,
            failureDetails: details,
            updatedAt: now(),
          });
          return {
            status: 'quarantined',
            jobId,
            quarantineItemId: qi ?? '',
            reason: 'validation-failed',
          };
        }

        for (const file of item.files) {
          // Size check
          let actualSize: number;
          try {
            const stat = await fsp.stat(file.stagedPath);
            actualSize = stat.size;
          } catch (err) {
            const details = `stat failed for ${file.suggestedName}: ${(err as Error).message}`;
            const qi = await safeCreateQuarantineItem(db, collectionId, file.stagedPath, 'validation-failed', details, now());
            if (qi) await safeUpdateJob(db, jobId, { status: 'quarantined', quarantineItemId: qi, updatedAt: now() });
            else await safeUpdateJob(db, jobId, { status: 'quarantined', updatedAt: now() });
            return { status: 'quarantined', jobId, quarantineItemId: qi ?? '', reason: 'validation-failed' };
          }

          if (actualSize > maxFileSize) {
            const details = `File "${file.suggestedName}" is ${actualSize} bytes, exceeds limit of ${maxFileSize} bytes`;
            const qi = await safeCreateQuarantineItem(db, collectionId, file.stagedPath, 'size-exceeds-limit', details, now());
            if (qi) await safeUpdateJob(db, jobId, { status: 'quarantined', quarantineItemId: qi, updatedAt: now() });
            else await safeUpdateJob(db, jobId, { status: 'quarantined', updatedAt: now() });
            return { status: 'quarantined', jobId, quarantineItemId: qi ?? '', reason: 'size-exceeds-limit' };
          }

          // Format check
          const detected = await sniffFormat(file.stagedPath);
          const normalizedExt = file.format?.toLowerCase() ?? '';
          const fmt = detected ?? normalizedExt;

          if (!fmt || !acceptedFormats.includes(fmt)) {
            const details = `File "${file.suggestedName}" has unsupported format: detected="${detected ?? 'null'}", extension="${normalizedExt}"`;
            const qi = await safeCreateQuarantineItem(db, collectionId, file.stagedPath, 'format-unsupported', details, now());
            if (qi) await safeUpdateJob(db, jobId, { status: 'quarantined', quarantineItemId: qi, updatedAt: now() });
            else await safeUpdateJob(db, jobId, { status: 'quarantined', updatedAt: now() });
            return { status: 'quarantined', jobId, quarantineItemId: qi ?? '', reason: 'format-unsupported' };
          }
        }

        // ── 6. Hash all files + dedup ─────────────────────────────────────────
        const fileHashes: string[] = [];
        for (const file of item.files) {
          try {
            const h = await sha256Hex(file.stagedPath);
            fileHashes.push(h);
          } catch {
            fileHashes.push('0'.repeat(64));
          }
        }

        // Dedup uses the FIRST staged file's hash as the primary key. For
        // multi-file Loots, adapters must emit files in a stable order (primary
        // 3D model first, auxiliaries after) so re-ingest hits the dedup path.
        // If files arrive in a different order on re-ingest, the source-identifier
        // dedup below is the fallback safety net — this is why adapters MUST emit
        // a stable sourceItemId. The `?? '0'.repeat(64)` fallback is defensive
        // only; the zero-files case is quarantined above so we always have
        // at least one real hash here.
        const primaryHash = fileHashes[0] ?? '0'.repeat(64);

        // Dedup by hash: look for an existing lootFile with matching hash.
        const existingByHash = await db()
          .select({ lootId: schema.lootFiles.lootId })
          .from(schema.lootFiles)
          .where(eq(schema.lootFiles.hash, primaryHash))
          .limit(1);

        if (existingByHash.length > 0 && existingByHash[0]) {
          const existingLootId = existingByHash[0].lootId;
          await ensureLootSourceRecord(db, existingLootId, item, now());
          await safeUpdateJob(db, jobId, { status: 'completed', lootId: existingLootId, updatedAt: now() });
          return { status: 'placed', jobId, lootId: existingLootId, deduped: true };
        }

        // Dedup by (sourceId, sourceItemId): look for an existing lootSourceRecord.
        const existingBySource = await db()
          .select({ lootId: schema.lootSourceRecords.lootId })
          .from(schema.lootSourceRecords)
          .where(
            and(
              eq(schema.lootSourceRecords.sourceType, item.sourceId),
              eq(schema.lootSourceRecords.sourceIdentifier, item.sourceItemId),
            ),
          )
          .limit(1);

        if (existingBySource.length > 0 && existingBySource[0]) {
          const existingLootId = existingBySource[0].lootId;
          await ensureLootSourceRecord(db, existingLootId, item, now());
          await safeUpdateJob(db, jobId, { status: 'completed', lootId: existingLootId, updatedAt: now() });
          return { status: 'placed', jobId, lootId: existingLootId, deduped: true };
        }

        // ── 7. Placement — new Loot ──────────────────────────────────────────
        await safeUpdateJob(db, jobId, { status: 'placing', updatedAt: now() });

        // Resolve collection to get stashRootId + pathTemplate.
        const collectionRows = await db()
          .select({
            stashRootId: schema.collections.stashRootId,
            pathTemplate: schema.collections.pathTemplate,
          })
          .from(schema.collections)
          .where(eq(schema.collections.id, collectionId))
          .limit(1);

        if (!collectionRows[0]) {
          const details = `Collection ${collectionId} not found`;
          await safeUpdateJob(db, jobId, { status: 'failed', failureReason: 'unknown', failureDetails: details, updatedAt: now() });
          return { status: 'failed', jobId, reason: 'unknown', details };
        }

        const { stashRootId, pathTemplate } = collectionRows[0];

        // Resolve stashRoot path.
        const stashRootRows = await db()
          .select({ path: schema.stashRoots.path })
          .from(schema.stashRoots)
          .where(eq(schema.stashRoots.id, stashRootId))
          .limit(1);

        if (!stashRootRows[0]) {
          const details = `StashRoot ${stashRootId} not found`;
          await safeUpdateJob(db, jobId, { status: 'failed', failureReason: 'unknown', failureDetails: details, updatedAt: now() });
          return { status: 'failed', jobId, reason: 'unknown', details };
        }

        const stashRootPath = stashRootRows[0].path;

        // Build AdoptionCandidate from the NormalizedItem.
        const candidateFiles = item.files.map((f, i) => ({
          absolutePath: f.stagedPath,
          relativePath: f.suggestedName, // pipeline uses copy-then-cleanup; basename is what applier uses
          size: f.size ?? 0,
          mtime: new Date(),
        }));

        const candidate: AdoptionCandidate = {
          id: crypto.randomUUID(),
          folderRelativePath: item.title,
          files: candidateFiles,
          classification: {
            title: { value: item.title, confidence: 1, source: 'metadata' },
            creator: item.creator ? { value: item.creator, confidence: 1, source: 'metadata' } : undefined,
            description: item.description ? { value: item.description, confidence: 1, source: 'metadata' } : undefined,
            license: item.license ? { value: item.license, confidence: 1, source: 'metadata' } : undefined,
            tags: item.tags ? { value: item.tags, confidence: 1, source: 'metadata' } : undefined,
            primaryFormat: undefined,
            needsUserInput: [],
          },
        };

        const placementResult = await applySingleCandidate({
          candidate,
          collectionId,
          stashRootPath,
          pathTemplate,
          mode: 'copy-then-cleanup',
          dbUrl,
        });

        if ('error' in placementResult) {
          const qi = await safeCreateQuarantineItem(
            db,
            collectionId,
            stagingDir,
            'placement-failed',
            placementResult.error,
            now(),
          );
          if (qi) await safeUpdateJob(db, jobId, { status: 'quarantined', quarantineItemId: qi, updatedAt: now() });
          else await safeUpdateJob(db, jobId, { status: 'quarantined', updatedAt: now() });
          return {
            status: 'quarantined',
            jobId,
            quarantineItemId: qi ?? '',
            reason: 'placement-failed',
          };
        }

        const newLootId = placementResult.lootId;

        // Create lootSourceRecords row.
        await ensureLootSourceRecord(db, newLootId, item, now());

        // Update job → completed.
        await safeUpdateJob(db, jobId, { status: 'completed', lootId: newLootId, updatedAt: now() });

        return { status: 'placed', jobId, lootId: newLootId, deduped: false };
      } catch (err) {
        // Adapter iterator sync-threw, mid-iteration threw, mkdir failed, or
        // any other unhandled error inside the pipeline run. Mark the job
        // failed so it doesn't stay in `fetching` / `placing` forever, and
        // return a structured outcome instead of propagating an unhandled
        // rejection to the caller.
        const details = err instanceof Error ? err.message : String(err);
        logger.warn({ jobId, err }, 'ingest: pipeline run threw — marking job failed');
        await safeUpdateJob(db, jobId, {
          status: 'failed',
          failureReason: 'unknown',
          failureDetails: details,
          updatedAt: now(),
        });
        return { status: 'failed', jobId, reason: 'unknown', details };
      } finally {
        // ── 8. Staging cleanup ────────────────────────────────────────────────
        try {
          await fsp.rm(stagingDir, { recursive: true, force: true });
        } catch (err) {
          logger.warn({ jobId, stagingDir, err }, 'ingest: staging cleanup failed (non-fatal)');
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

/**
 * Update ingest_jobs fields, swallowing errors so a DB write failure inside
 * the event loop doesn't abort the entire pipeline run.
 */
async function safeUpdateJob(
  db: () => DB,
  jobId: string,
  fields: Partial<typeof schema.ingestJobs.$inferInsert>,
): Promise<void> {
  try {
    await db().update(schema.ingestJobs).set(fields).where(eq(schema.ingestJobs.id, jobId));
  } catch (err) {
    logger.warn({ jobId, fields, err }, 'ingest: failed to update job status (non-fatal)');
  }
}

/**
 * Create a quarantine_items row. Returns the new quarantine item id, or null
 * on DB failure (so the pipeline can still return a quarantined outcome).
 *
 * The quarantine_items table requires a stashRootId FK. We resolve it from
 * the collection. If the collection is gone, we fall back to a synthetic path.
 */
async function safeCreateQuarantineItem(
  db: () => DB,
  collectionId: string,
  quarantinePath: string,
  reason: string,
  details: string,
  createdAt: Date,
): Promise<string | null> {
  try {
    // Resolve stashRootId from collection.
    const colRows = await db()
      .select({ stashRootId: schema.collections.stashRootId })
      .from(schema.collections)
      .where(eq(schema.collections.id, collectionId))
      .limit(1);

    const stashRootId = colRows[0]?.stashRootId;
    if (!stashRootId) {
      logger.warn({ collectionId }, 'ingest: cannot create quarantine item — collection/stashRoot not found');
      return null;
    }

    const qiId = crypto.randomUUID();
    await db().insert(schema.quarantineItems).values({
      id: qiId,
      stashRootId,
      path: quarantinePath,
      reason,
      details: JSON.stringify({ message: details }),
      createdAt,
      resolvedAt: null,
    });
    return qiId;
  } catch (err) {
    logger.warn({ err, reason, details }, 'ingest: failed to create quarantine item (non-fatal)');
    return null;
  }
}

/**
 * Upsert a lootSourceRecords row for the given loot + normalized item.
 * Swallows errors (e.g. unique-constraint violations on concurrent ingests).
 */
async function ensureLootSourceRecord(
  db: () => DB,
  lootId: string,
  item: NormalizedItem,
  capturedAt: Date,
): Promise<void> {
  try {
    await db().insert(schema.lootSourceRecords).values({
      id: crypto.randomUUID(),
      lootId,
      sourceType: item.sourceId,
      sourceUrl: item.sourceUrl ?? null,
      sourceIdentifier: item.sourceItemId,
      capturedAt,
    });
  } catch {
    // Unique constraint violation is expected on dedup paths — ignore.
  }
}
