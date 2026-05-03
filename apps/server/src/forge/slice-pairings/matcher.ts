/**
 * V2-005e-T_e3: Three-tier source-Loot association.
 *
 * Replaces the T_e2 stub `handleSliceArrival`. For each slicer-output file
 * arriving on a watched forge_inboxes path:
 *
 *   1. Ingest the slice file as a `loot` + `loot_files` row owned by the
 *      inbox owner. (V2-005e-T_e3 simplification — see below.)
 *   2. Tier 1: parse sidecar metadata (.gcode.3mf model_settings.config or
 *      .gcode header comments). If a source filename hint is found AND
 *      maps to a Loot row owned by this user, set parent_loot_id.
 *   3. Tier 2: filename-similarity match (Dice's bigram coefficient) over
 *      owner Loot titles, after stripping slicer suffix patterns. Confidence
 *      >= 0.7 wins.
 *   4. Tier 3: write a forge_pending_pairings row with resolved_at=NULL so
 *      the user can pair manually via the UI.
 *
 * --- T_e3 simplification on ingest ---
 *
 * The V2-002 adoption engine + applySingleCandidate require a target
 * Collection + path template + stashRoot. forge_inboxes does not bind to a
 * collection (by design — the inbox is purely a watch path). Per-slice
 * collection-picking is out of scope for T_e3.
 *
 * The simplification: pick the inbox owner's first existing Collection (in
 * insertion order) as the slice's `collectionId`. The slice's loot_files row
 * stores the inbox-arrival path AS-IS (origin='inbox'), without copying or
 * linking via the FS adapter. If the owner has NO Collection yet, the slice
 * is logged + skipped (it'll arrive again on next slicer save, by which
 * point the user will likely have created a Collection).
 *
 * V2-005e-CF-Z (deferred carry-forward) will add proper FS adapter handoff
 * + per-inbox collection binding + path-template-driven placement.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';

import { getServerDb, schema } from '../../db/client';
import { logger } from '../../logger';
import { sha256Hex } from '../../stash/hash-util';
import type { ForgeInboxRow } from '../inboxes/types';
import { parseSidecar } from './sidecar-parser';
import { heuristicMatchForSlice, HEURISTIC_THRESHOLD } from './filename-heuristic';

export interface SliceArrivalMatchArgs {
  inbox: ForgeInboxRow;
  filePath: string;
}

export interface SliceArrivalMatchOpts {
  dbUrl?: string;
}

export interface SliceArrivalMatchResult {
  /** The Loot row created for this slice, or null if ingest was skipped. */
  sliceLootId: string | null;
  /** Source Loot the matcher associated, or null if pending or skipped. */
  parentLootId: string | null;
  /** Pending-pairing row id when no source could be matched, else null. */
  pendingPairingId: string | null;
  /** When sliceLootId is null, an explanation suitable for log context. */
  skipReason?:
    | 'no-collection-for-owner'
    | 'stat-failed'
    | 'hash-failed'
    | 'unexpected';
}

/**
 * Process a single slicer-output arrival end-to-end (post-classification).
 * Called from `forge/inboxes/ingest.ts` after the watcher's classifier
 * confirms slicerOutput=true. NEVER throws — all failure paths log + return
 * a structured outcome.
 */
export async function matchSliceArrival(
  args: SliceArrivalMatchArgs,
  opts: SliceArrivalMatchOpts = {},
): Promise<SliceArrivalMatchResult> {
  const { inbox, filePath } = args;

  const sliceLootId = await ingestSliceAsLoot(inbox, filePath, opts);
  if (typeof sliceLootId !== 'string') {
    return {
      sliceLootId: null,
      parentLootId: null,
      pendingPairingId: null,
      skipReason: sliceLootId.reason,
    };
  }

  // Tier 1: sidecar metadata.
  let parentLootId: string | null = null;
  const sidecar = await parseSidecar(filePath);
  if (sidecar?.sourceBasename) {
    parentLootId = await findLootByBasename(
      inbox.ownerId,
      sidecar.sourceBasename,
      sliceLootId,
      opts,
    );
    if (parentLootId !== null) {
      logger.info(
        {
          sliceLootId,
          parentLootId,
          sourceBasename: sidecar.sourceBasename,
        },
        'slice-pairing: sidecar match',
      );
    }
  }

  // Tier 2: filename heuristic.
  if (parentLootId === null) {
    const heur = await heuristicMatchForSlice(
      {
        ownerId: inbox.ownerId,
        sliceBasename: path.basename(filePath),
        excludeLootId: sliceLootId,
      },
      opts,
    );
    if (heur && heur.confidence >= HEURISTIC_THRESHOLD) {
      parentLootId = heur.lootId;
      logger.info(
        { sliceLootId, parentLootId, confidence: heur.confidence },
        'slice-pairing: filename-heuristic match',
      );
    }
  }

  const db = getServerDb(opts.dbUrl);
  if (parentLootId !== null) {
    await db
      .update(schema.loot)
      .set({ parentLootId })
      .where(eq(schema.loot.id, sliceLootId));
    return { sliceLootId, parentLootId, pendingPairingId: null };
  }

  // Tier 3: queue for manual resolve.
  const pendingPairingId = crypto.randomUUID();
  await db.insert(schema.forgePendingPairings).values({
    id: pendingPairingId,
    sliceLootId,
    sourceFilenameHint: path.basename(filePath),
  });
  logger.info(
    {
      sliceLootId,
      sliceBasename: path.basename(filePath),
      pendingPairingId,
    },
    'slice-pairing: queued for manual resolve',
  );
  return { sliceLootId, parentLootId: null, pendingPairingId };
}

// ---------------------------------------------------------------------------
// ingestSliceAsLoot — T_e3 simplification (no FS adapter handoff yet)
// ---------------------------------------------------------------------------

type IngestSkip = { reason: NonNullable<SliceArrivalMatchResult['skipReason']> };

async function ingestSliceAsLoot(
  inbox: ForgeInboxRow,
  filePath: string,
  opts: SliceArrivalMatchOpts,
): Promise<string | IngestSkip> {
  const db = getServerDb(opts.dbUrl);

  // Pick the owner's first Collection. If none, skip — user must create
  // one before slice arrivals can be ingested.
  const colRows = await db
    .select({
      id: schema.collections.id,
      stashRootId: schema.collections.stashRootId,
    })
    .from(schema.collections)
    .where(eq(schema.collections.ownerId, inbox.ownerId))
    .limit(1);
  const collection = colRows[0];
  if (!collection) {
    logger.warn(
      { inboxId: inbox.id, ownerId: inbox.ownerId, filePath },
      'slice-pairing: no collection for owner — skipping ingest',
    );
    return { reason: 'no-collection-for-owner' };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, filePath },
      'slice-pairing: stat failed for slice file',
    );
    return { reason: 'stat-failed' };
  }

  let hash: string;
  try {
    hash = await sha256Hex(filePath);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, filePath },
      'slice-pairing: hash failed for slice file',
    );
    return { reason: 'hash-failed' };
  }

  const basename = path.basename(filePath);
  const format = inferFormat(basename);
  const lootId = crypto.randomUUID();
  const lootFileId = crypto.randomUUID();
  const now = new Date();

  try {
    await db.transaction((tx) => {
      tx.insert(schema.loot)
        .values({
          id: lootId,
          collectionId: collection.id,
          title: basename,
          description: null,
          tags: [],
          creator: null,
          license: null,
          sourceItemId: null,
          contentSummary: null,
          fileMissing: false,
          parentLootId: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(schema.lootFiles)
        .values({
          id: lootFileId,
          lootId,
          // Path stored AS-IS (absolute) — T_e3 simplification. CF-Z will
          // convert this to a stashRoot-relative path once FS adapter
          // handoff is wired.
          path: filePath,
          format,
          size: stat.size,
          hash,
          origin: 'inbox',
          provenance: {
            source: 'forge-inbox',
            inboxId: inbox.id,
            inboxPath: inbox.path,
          },
          createdAt: now,
        })
        .run();
    });
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        filePath,
        inboxId: inbox.id,
      },
      'slice-pairing: ingest insert failed',
    );
    return { reason: 'unexpected' };
  }

  return lootId;
}

function inferFormat(basename: string): string {
  const lower = basename.toLowerCase();
  if (lower.endsWith('.gcode.3mf')) return 'gcode.3mf';
  const ext = path.extname(lower);
  return ext.length > 1 ? ext.slice(1) : 'unknown';
}

// ---------------------------------------------------------------------------
// findLootByBasename — sidecar Tier 1 lookup
// ---------------------------------------------------------------------------

/**
 * Look up an owner's source Loot by basename, matching either the literal
 * filename OR the filename-with-extension-stripped against `loot.title`.
 * Slice rows (parent_loot_id IS NOT NULL) are excluded — sidecar hints are
 * only useful for source association.
 *
 * The sidecar source_file value can be either a basename (`cube.stl`) or a
 * relative path (`subdir/cube.stl`); we normalize via `path.basename` and
 * also try the stem (no extension).
 */
async function findLootByBasename(
  ownerId: string,
  basenameHint: string,
  excludeLootId: string,
  opts: SliceArrivalMatchOpts,
): Promise<string | null> {
  const db = getServerDb(opts.dbUrl);
  const normalized = path.basename(basenameHint);
  const stem = path.parse(normalized).name;

  // Match exact title OR title-equals-stem (case-insensitive). Exclude the
  // just-inserted slice itself from the candidate set.
  const candidates = await db
    .select({
      id: schema.loot.id,
      title: schema.loot.title,
    })
    .from(schema.loot)
    .innerJoin(
      schema.collections,
      eq(schema.loot.collectionId, schema.collections.id),
    )
    .where(
      and(
        eq(schema.collections.ownerId, ownerId),
        isNull(schema.loot.parentLootId),
        ne(schema.loot.id, excludeLootId),
      ),
    );

  // Two-pass match: exact (title === basename or stem) first, fall back to
  // case-insensitive equality on either form.
  for (const c of candidates) {
    if (c.title === normalized || c.title === stem) {
      return c.id;
    }
  }
  const lowerHint = normalized.toLowerCase();
  const lowerStem = stem.toLowerCase();
  for (const c of candidates) {
    const t = c.title.toLowerCase();
    if (t === lowerHint || t === lowerStem) {
      return c.id;
    }
  }
  return null;
}
