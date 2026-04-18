import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, blob, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// Shared column builders keep Postgres + SQLite schemas aligned.
const id = () => text('id').primaryKey();
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const destinations = sqliteTable('destinations', {
  id: id(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'filesystem'
  config: text('config', { mode: 'json' }).notNull(),
  packager: text('packager').notNull(), // 'manyfold-v0'
  credentialId: text('credential_id'), // nullable FK
  createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: ts('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
});

export const items = sqliteTable(
  'items',
  {
    id: id(),
    sourceId: text('source_id').notNull(),
    sourceItemId: text('source_item_id').notNull(),
    contentType: text('content_type').notNull(),
    sourceUrl: text('source_url').notNull(),
    snapshot: text('snapshot', { mode: 'json' }),
    destinationId: text('destination_id'),
    credentialId: text('credential_id'),
    status: text('status').notNull(), // queued|running|done|failed|skipped
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    outputPath: text('output_path'),
    createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: ts('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
    completedAt: ts('completed_at'),
  },
  (t) => ({
    doneUniq: uniqueIndex('items_done_unique')
      .on(t.sourceId, t.sourceItemId)
      .where(sql`status = 'done'`),
    statusIdx: index('items_status_idx').on(t.status),
  }),
);

export const itemEvents = sqliteTable('item_events', {
  id: id(),
  itemId: text('item_id').notNull(),
  kind: text('kind').notNull(),
  message: text('message'),
  meta: text('meta', { mode: 'json' }),
  createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
});

export const sourceCredentials = sqliteTable(
  'source_credentials',
  {
    id: id(),
    sourceId: text('source_id').notNull(),
    label: text('label').notNull(),
    kind: text('kind').notNull(), // cookie-jar | oauth-token | api-key
    encryptedBlob: blob('encrypted_blob').notNull(),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    status: text('status').notNull().default('active'),
    createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({ labelUniq: uniqueIndex('src_cred_label_uniq').on(t.sourceId, t.label) }),
);

export const apiKeys = sqliteTable('api_keys', {
  id: id(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  scopes: text('scopes').notNull(), // csv
  lastUsedAt: ts('last_used_at'),
  createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  revokedAt: ts('revoked_at'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: ts('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
});

export const users = sqliteTable('users', {
  id: id(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash'), // nullable if OIDC-only
  role: text('role').notNull().default('admin'),
  createdAt: ts('created_at').notNull().default(sql`(unixepoch() * 1000)`),
});
