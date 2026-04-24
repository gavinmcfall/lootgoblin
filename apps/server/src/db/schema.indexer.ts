/**
 * Indexer tables — V2-002-T11
 *
 * Entities:
 *   lootThumbnails — per-loot sidecar tracking: thumbnail generation status,
 *                    path (relative to stash root), and failure state.
 *
 * FTS5 virtual table (loot_fts) is NOT modelled via Drizzle — Drizzle's
 * sqlite-core does not support VIRTUAL TABLE definitions. The indexer module
 * interacts with loot_fts exclusively via raw `db.run(sql\`...\`)` queries.
 *
 * Status values:  'pending' | 'ok' | 'failed'
 * source_kind:    'f3d-cli' | '3mf-embedded' | null (when pending/failed)
 *
 * IMPORTANT DB invariant — thumbnail_path may be NON-NULL when status is
 * 'failed'. This represents a prior successful thumbnail whose retry failed;
 * the file is intentionally preserved on disk (non-destructive retry).
 * Consumers wanting only usable thumbnails MUST filter WHERE status = 'ok'.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { loot } from './schema.stash';

// ---------------------------------------------------------------------------
// lootThumbnails
// ---------------------------------------------------------------------------

/**
 * Per-loot thumbnail generation state.
 *
 * One row per Loot item — created on first indexLoot() call, updated on every
 * regenerateThumbnail() outcome. Deleted automatically when the Loot is
 * deleted (ON DELETE CASCADE via the FK in the SQL migration).
 *
 * thumbnail_path is relative to stashRoot.path, e.g. 'thumbnails/abc-123.png'.
 * It is NULL when status = 'pending' or status = 'failed'.
 */
export const lootThumbnails = sqliteTable(
  'loot_thumbnails',
  {
    /**
     * FK → loot.id. Cascade via SQL migration (raw REFERENCES clause).
     * Drizzle references() cannot express ON DELETE CASCADE on a PRIMARY KEY
     * column in the same way as the raw SQL, so the FK is declared in the
     * migration only.
     */
    lootId: text('loot_id')
      .primaryKey()
      .references(() => loot.id, { onDelete: 'cascade' }),
    /**
     * Relative path from stashRoot.path to the PNG sidecar.
     *
     * NULL on initial 'pending' or if no thumbnail has ever been generated.
     * MAY BE NON-NULL when status is 'failed' — this represents a previously
     * successful thumbnail whose latest retry failed; the file is preserved
     * on disk. Callers wanting only usable thumbnails MUST also check
     * `status = 'ok'`. See module JSDoc in indexer.ts for rationale.
     */
    thumbnailPath: text('thumbnail_path'),
    /**
     * Generation lifecycle state.
     * 'pending'  — row was created but thumbnail generation hasn't run yet.
     * 'ok'       — thumbnail successfully generated at thumbnail_path.
     * 'failed'   — last generation attempt failed; error contains the reason.
     */
    status: text('status').notNull(),
    /**
     * Which code path produced the thumbnail.
     * 'f3d-cli'       — F3D subprocess rendered a thumbnail.
     * '3mf-embedded'  — Metadata/thumbnail.png extracted from the 3MF archive.
     * NULL when status is 'pending' or 'failed'.
     */
    sourceKind: text('source_kind'),
    /** Failure reason, populated when status = 'failed'. NULL otherwise. */
    error: text('error'),
    /** Unix-epoch-ms timestamp of the last successful generation. NULL until first success. */
    generatedAt: integer('generated_at', { mode: 'timestamp_ms' }),
    /** Unix-epoch-ms timestamp of the last status update (any outcome). */
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    /** Fast lookup for batch thumbnail jobs: WHERE status = 'pending'. */
    index('loot_thumbnails_status_idx').on(t.status),
  ],
);
