/**
 * Inbox Triage tables — V2-002-T8
 *
 * Entities:
 *   inboxTriageRules   — per-user auto-apply rules keyed to a Collection;
 *                        evaluated in priority order on every new inbox file.
 *   inboxPendingItems  — files the triage engine has seen but could not
 *                        auto-apply (low confidence, no matching rule, rule
 *                        error). Awaiting user review.
 *
 * Design notes:
 *   - inboxPendingItems has NO owner FK — the inbox is a single shared queue
 *     in v2. ownerId is an API argument for listPending/confirmPlacement so
 *     multi-inbox work in v3+ doesn't require signature changes.
 *   - inboxTriageRules.collection_id cascades on collection delete to keep the
 *     rule set tidy without a separate cleanup job.
 *   - classification is stored as JSON text (NOT text({ mode: 'json' })) so we
 *     can parse it explicitly in application code — avoids Drizzle's implicit
 *     deserialisation path which can mask type errors.
 */

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { user } from './schema.auth';
import { collections } from './schema.stash';

// ---------------------------------------------------------------------------
// Shared helpers (local to this module — schema.stash has its own)
// ---------------------------------------------------------------------------

const pk = () => text('id').primaryKey();
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

// ---------------------------------------------------------------------------
// inboxTriageRules
// ---------------------------------------------------------------------------

/**
 * Auto-apply rules for inbox triage.
 *
 * When a new file appears in the inbox:
 *   1. Classifier runs.
 *   2. Rules are evaluated in priority asc (lower number = higher precedence).
 *   3. First rule whose filename_pattern matches AND whose min_confidence ≤
 *      classification confidence auto-applies the file to collection_id.
 *
 * Deleted automatically when the referenced Collection is deleted (cascade).
 */
export const inboxTriageRules = sqliteTable(
  'inbox_triage_rules',
  {
    id: pk(),
    /** FK → BetterAuth user.id. Cascade: user delete removes their rules. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * Regex pattern (compiled in JS) tested against the file basename.
     * Use '.*' to match all files.
     */
    filenamePattern: text('filename_pattern').notNull(),
    /**
     * Minimum classifier confidence (0.0–1.0) for the title field to
     * auto-apply. If classification.title.confidence < minConfidence,
     * the rule is not triggered.
     */
    minConfidence: real('min_confidence').notNull(),
    /**
     * FK → collections.id.
     * Cascade: collection delete removes rules targeting it.
     */
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    /**
     * Apply mode — passed through to T7's applier helpers.
     * 'in-place': register file at existing path (no FS move).
     * 'copy-then-cleanup': move file to template-resolved path.
     */
    mode: text('mode', { enum: ['in-place', 'copy-then-cleanup'] }).notNull(),
    /**
     * Evaluation order — lower numbers evaluated first.
     * Multiple rules with the same priority are evaluated in insertion order.
     */
    priority: integer('priority').notNull().default(100),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('inbox_triage_rules_owner_idx').on(t.ownerId),
    index('inbox_triage_rules_priority_idx').on(t.priority),
  ],
);

// ---------------------------------------------------------------------------
// inboxPendingItems
// ---------------------------------------------------------------------------

/**
 * Inbox files awaiting user review.
 *
 * Inserted when:
 *   - No rule matched (reason = 'no-rule-matched').
 *   - A rule matched but confidence was below the rule's threshold
 *     (reason = 'low-confidence').
 *   - A rule matched + confidence was sufficient but the applier failed
 *     (reason = 'rule-error').
 *
 * Removed when:
 *   - User confirms placement (file moved, Loot created).
 *   - User dismisses (file stays in inbox, row deleted).
 *   - File is deleted from inbox (unlink event).
 *
 * inbox_path UNIQUE ensures each physical file has at most one pending row.
 * Re-triage (change event) UPSERTs into this table by path.
 */
export const inboxPendingItems = sqliteTable(
  'inbox_pending_items',
  {
    id: pk(),
    /** Absolute path to the file in the inbox directory. */
    inboxPath: text('inbox_path').notNull().unique(),
    /**
     * Cached ClassificationResult serialised as JSON.
     * Parsed by application code — not auto-deserialised by Drizzle.
     */
    classification: text('classification').notNull(),
    /** SHA-256 hex digest of the file at detection time. */
    hash: text('hash').notNull(),
    /** File size in bytes at detection time. */
    size: integer('size').notNull(),
    /**
     * Why auto-apply did not fire.
     * 'low-confidence'   — best rule's minConfidence not met.
     * 'no-rule-matched'  — no rule's filename_pattern matched.
     * 'rule-error'       — rule matched + confident but applier threw.
     */
    reason: text('reason', {
      enum: ['low-confidence', 'no-rule-matched', 'rule-error'],
    }).notNull(),
    /** When the triage engine first detected this file. */
    detectedAt: ts('detected_at').notNull(),
    /** Updated on re-triage (change event). Equals detectedAt on first insert. */
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('inbox_pending_items_detected_idx').on(t.detectedAt),
  ],
);

// ---------------------------------------------------------------------------
// Re-exported convenience types
// ---------------------------------------------------------------------------

export type InboxTriageRule = typeof inboxTriageRules.$inferSelect;
export type InboxPendingItem = typeof inboxPendingItems.$inferSelect;
