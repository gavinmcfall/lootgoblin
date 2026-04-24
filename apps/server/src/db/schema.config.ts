/**
 * Config-resolver tables — V2-001-T3
 *
 * instanceConfig  — stores runtime-mutable config values written by the
 *                   setup wizard (T8) or Stash UI.
 * configProvenance — audit log of where each key was last resolved from.
 */

import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

/**
 * Key-value store for runtime-mutable config values.
 * Values are serialised as JSON text so any scalar or object can be stored.
 * updated_by is nullable — NULL means written by the system (e.g. wizard auto-seed).
 */
export const instanceConfig = sqliteTable('instance_config', {
  key: text('key').primaryKey(),
  /** JSON-encoded value. */
  value: text('value', { mode: 'json' }),
  updatedAt: ts('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  /** FK to BetterAuth user.id — nullable (NULL = system write). */
  updatedBy: text('updated_by'),
});

/**
 * Audit table — one row per config key, overwritten on every resolve() call.
 * Records which tier the value came from and when.
 */
export const configProvenance = sqliteTable('config_provenance', {
  key: text('key').primaryKey(),
  /** Resolution tier: 'secrets' | 'file' | 'db' | 'default' */
  source: text('source').notNull(),
  resolvedAt: ts('resolved_at').notNull().default(sql`(unixepoch() * 1000)`),
  /** Extra detail about the source (e.g. env-var name, YAML file path). */
  sourceDetail: text('source_detail'),
});
