/**
 * Stash pillar tables — V2-002-T1
 *
 * Entities:
 *   stashRoots         — top-level filesystem roots (one per user library location)
 *   collections        — named, path-templated buckets within a root
 *   loot               — canonical items stored under a collection
 *   lootFiles          — individual files belonging to a loot item
 *   lootSourceRecords  — multi-source attribution per loot item
 *   lootRelationships  — loot-to-loot edges (reserved; V3+ will query)
 *   quarantineItems    — failed-validation artifacts awaiting user resolution
 *
 * FK strategy:
 *   - cascade: parent delete removes children (collection → loot → files/records/relationships)
 *   - restrict: stashRoot delete blocked if Collections reference it (data integrity guard)
 *
 * JSON columns: text({ mode: 'json' }) — SQLite has no native array/object type.
 * Timestamps:   integer({ mode: 'timestamp_ms' }) with unixepoch()*1000 SQL defaults.
 * PKs:          app-side crypto.randomUUID() — no DB-side uuid() in SQLite.
 */

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { user } from './schema.auth';

// ---------------------------------------------------------------------------
// Shared column builders
// ---------------------------------------------------------------------------

const pk = () => text('id').primaryKey();
const ts = (name: string) =>
  integer(name, { mode: 'timestamp_ms' });

// ---------------------------------------------------------------------------
// stashRoots
// ---------------------------------------------------------------------------

/**
 * Top-level filesystem roots.
 *
 * Each user can have multiple roots (e.g. one per NAS mount).
 * Collections live inside a root; deleting a root that still has Collections
 * is blocked (restrict) to prevent orphaned path resolution.
 */
export const stashRoots = sqliteTable('stash_roots', {
  id: pk(),
  /** FK → BetterAuth user.id. Cascade: user delete removes all their roots. */
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** Human-readable label, e.g. "NAS Library". */
  name: text('name').notNull(),
  /** Absolute filesystem path to the root directory. */
  path: text('path').notNull(),
  createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: ts('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
});

// ---------------------------------------------------------------------------
// collections
// ---------------------------------------------------------------------------

/**
 * Named, path-templated buckets within a stash root.
 *
 * UNIQUE(ownerId, name) — a user can't have two Collections with the same name.
 * FK to stashRoots uses RESTRICT so you can't accidentally orphan a Collection
 * by deleting its root.
 */
export const collections = sqliteTable(
  'collections',
  {
    id: pk(),
    /** FK → BetterAuth user.id. Cascade: user delete removes all their collections. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Human-readable name, e.g. "Mechanical Keyboards". */
    name: text('name').notNull(),
    /**
     * Path template for resolving the on-disk location of loot inside this collection.
     * Template syntax (to be formalised in V2-002-T2): `{creator|slug}/{title|slug}`.
     */
    pathTemplate: text('path_template').notNull(),
    /**
     * FK → stashRoots.id.
     * RESTRICT on delete: you cannot remove a root while Collections still reference it.
     */
    stashRootId: text('stash_root_id')
      .notNull()
      .references(() => stashRoots.id, { onDelete: 'restrict' }),
    createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: ts('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** Fast lookup of a user's Collections list. */
    index('collections_owner_id_idx').on(t.ownerId),
    /** Fast lookup of Collections within a root (e.g. for root detail page). */
    index('collections_stash_root_id_idx').on(t.stashRootId),
    /** A user can't have two Collections with the same name. */
    uniqueIndex('collections_owner_name_uniq').on(t.ownerId, t.name),
  ],
);

// ---------------------------------------------------------------------------
// loot
// ---------------------------------------------------------------------------

/**
 * Canonical items stored under a collection.
 *
 * One Loot = one logical "thing" (model, print profile, document, etc.).
 * Physical files live in lootFiles.
 */
export const loot = sqliteTable(
  'loot',
  {
    id: pk(),
    /** FK → collections.id. Cascade: collection delete removes all its loot. */
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    /** Human-readable title. */
    title: text('title').notNull(),
    /** Optional long-form description. */
    description: text('description'),
    /** Array of string tags. Stored as JSON. */
    tags: text('tags', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default(sql`(json('[]'))`),
    /** Creator / designer name. */
    creator: text('creator'),
    /** SPDX license identifier or free text. */
    license: text('license'),
    /**
     * Reserved for V2-003 Scavengers attribution.
     * Stores the external platform's item ID that sourced this loot.
     * No FK yet — Scavengers will define the relationship.
     */
    sourceItemId: text('source_item_id'),
    /**
     * Structured JSON of inferred metadata (e.g. detected file types, estimated
     * print time, auto-detected tags). Shape TBD by Classifier (V2-002-T9+).
     */
    contentSummary: text('content_summary', { mode: 'json' }),
    /**
     * Set by Reconciliation (V2-002+) when the underlying file disappears.
     * Allows the UI to flag drifted items without deleting the record.
     */
    fileMissing: integer('file_missing', { mode: 'boolean' }).notNull().default(false),
    /**
     * V2-005e-T_e1: Slice → source Loot fast-path FK. When this Loot row is a
     * sliced-output artifact (gcode / .3mf-with-gcode / etc.) ingested via the
     * forge inbox watcher, `parent_loot_id` points at the source-model Loot it
     * was sliced from. Every slice has at most one source; ON DELETE SET NULL
     * preserves the slice row when its source is removed.
     *
     * Distinct from the `loot_relationships` m:n graph (V3+ remix/derivative
     * edges) — this is a single, indexed FK for the dispatch-time lookup
     * "given this slice, what's the source it came from?".
     */
    parentLootId: text('parent_loot_id').references(
      (): AnySQLiteColumn => loot.id,
      { onDelete: 'set null' },
    ),
    createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: ts('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** Primary listing query: all loot in a collection. */
    index('loot_collection_id_idx').on(t.collectionId),
    /** Reconciliation query: what's drifted (WHERE file_missing = 1). */
    index('loot_file_missing_idx').on(t.fileMissing),
    /** V2-005e-T_e1: slice → source fast-path lookup. */
    index('idx_loot_parent').on(t.parentLootId),
  ],
);

// ---------------------------------------------------------------------------
// lootFiles
// ---------------------------------------------------------------------------

/**
 * Individual files belonging to a loot item.
 *
 * Paths are relative to stashRoots.path so the library remains portable.
 * The hash field enables dedup and integrity-check lookups.
 */
export const lootFiles = sqliteTable(
  'loot_files',
  {
    id: pk(),
    /** FK → loot.id. Cascade: loot delete removes all its files. */
    lootId: text('loot_id')
      .notNull()
      .references(() => loot.id, { onDelete: 'cascade' }),
    /**
     * File path relative to stashRoots.path.
     * E.g. "Mechanical Keyboards/Topre/topre-switch-v2/topre-switch-v2.3mf"
     */
    path: text('path').notNull(),
    /** File extension / format, e.g. "3mf", "stl", "png", "pdf". */
    format: text('format').notNull(),
    /** File size in bytes. */
    size: integer('size').notNull(),
    /** SHA-256 hex digest of the file content. */
    hash: text('hash').notNull(),
    /**
     * How the file entered the stash.
     * Values: "ingest" | "adoption" | "inbox" | "manual"
     */
    origin: text('origin').notNull(),
    /**
     * Structured provenance: source URL, download timestamp, etc.
     * Shape TBD by Scavengers (V2-003).
     */
    provenance: text('provenance', { mode: 'json' }),
    createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** Primary listing query: files for a loot item. */
    index('loot_files_loot_id_idx').on(t.lootId),
    /** Dedup + integrity-check: find files by hash. */
    index('loot_files_hash_idx').on(t.hash),
  ],
);

// ---------------------------------------------------------------------------
// lootSourceRecords
// ---------------------------------------------------------------------------

/**
 * Multi-source attribution per loot item.
 *
 * A single Loot might originate from MakerWorld AND be cross-posted on Printables.
 * Each row records one platform's attribution.
 *
 * UNIQUE(lootId, sourceType, sourceIdentifier) prevents duplicate attribution rows.
 */
export const lootSourceRecords = sqliteTable(
  'loot_source_records',
  {
    id: pk(),
    /** FK → loot.id. Cascade: loot delete removes all its source records. */
    lootId: text('loot_id')
      .notNull()
      .references(() => loot.id, { onDelete: 'cascade' }),
    /**
     * Platform identifier.
     * Values: "makerworld" | "printables" | "patreon" | "manual" | ...
     */
    sourceType: text('source_type').notNull(),
    /** URL on the source platform (nullable — some sources have no stable URL). */
    sourceUrl: text('source_url'),
    /**
     * External item ID on the source platform. Nullable by design — some capture paths
     * (manual upload, scraped-without-ID) have no stable identifier.
     *
     * NOTE on the UNIQUE index below: SQLite treats NULL values as distinct, so multiple
     * rows with (lootId, sourceType, NULL) are INTENTIONALLY allowed. Deduplication
     * via this constraint only applies when sourceIdentifier is non-null. Callers that
     * need strict dedup should populate this field or dedup in application code.
     */
    sourceIdentifier: text('source_identifier'),
    /** When this attribution was recorded. */
    capturedAt: ts('captured_at').notNull(),
  },
  (t) => [
    /** List all sources for a given loot item. */
    index('loot_source_records_loot_id_idx').on(t.lootId),
    /** Prevent duplicate attribution: same loot, same platform, same ID. */
    uniqueIndex('loot_source_records_loot_type_id_uniq').on(
      t.lootId,
      t.sourceType,
      t.sourceIdentifier,
    ),
  ],
);

// ---------------------------------------------------------------------------
// lootRelationships
// ---------------------------------------------------------------------------

/**
 * Loot-to-loot relationship edges.
 *
 * Reserved for V3+ — v2 does not query this table. Schema is defined now so
 * the migration is stable and downstream tasks know it exists.
 *
 * Example relationship values: "remix-of" | "part-of" | "requires" | "supersedes"
 */
export const lootRelationships = sqliteTable('loot_relationships', {
  id: pk(),
  /** FK → loot.id. Cascade: parent loot delete removes outbound edges. */
  parentLootId: text('parent_loot_id')
    .notNull()
    .references(() => loot.id, { onDelete: 'cascade' }),
  /** FK → loot.id. Cascade: child loot delete removes inbound edges. */
  childLootId: text('child_loot_id')
    .notNull()
    .references(() => loot.id, { onDelete: 'cascade' }),
  /**
   * Semantic type of the relationship.
   * Values: "remix-of" | "part-of" | "requires" | "supersedes"
   */
  relationship: text('relationship').notNull(),
  createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
});

// ---------------------------------------------------------------------------
// quarantineItems
// ---------------------------------------------------------------------------

/**
 * Failed-validation artifacts awaiting user resolution.
 *
 * When the Indexer or Reconciliation pass cannot safely place a file into a
 * Collection (integrity failure, template mismatch, etc.), it lands here.
 * The user can retry or dismiss each item.
 */
export const quarantineItems = sqliteTable(
  'quarantine_items',
  {
    id: pk(),
    /** FK → stashRoots.id. Cascade: root delete removes its quarantine queue. */
    stashRootId: text('stash_root_id')
      .notNull()
      .references(() => stashRoots.id, { onDelete: 'cascade' }),
    /** Absolute path to the quarantined file (kept absolute for unambiguous resolution). */
    path: text('path').notNull(),
    /**
     * Why the file was quarantined.
     * Values: "integrity-failed" | "template-incompatible" | "unclassifiable" | "needs-user-input"
     */
    reason: text('reason').notNull(),
    /** Structured error info for UI display. Shape TBD. */
    details: text('details', { mode: 'json' }),
    createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    /** Set when the user retries or dismisses the item. NULL = still pending. */
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    /** Quarantine queue for a specific root. */
    index('quarantine_items_stash_root_id_idx').on(t.stashRootId),
    /** Unresolved-queue lookups: WHERE resolved_at IS NULL. */
    index('quarantine_items_resolved_at_idx').on(t.resolvedAt),
  ],
);
