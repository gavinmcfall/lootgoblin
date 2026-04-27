/**
 * Integration tests for the gdrive_watch_channels schema — V2-004b-T1.
 *
 * Real SQLite DB at /tmp/lootgoblin-t1-gdrive-channels.db.
 *
 * Coverage:
 *   1. Migration applies cleanly to a fresh DB.
 *   2. Insert + retrieve a channel row.
 *   3. UNIQUE index on channel_id — duplicate insert fails.
 *   4. FK enforcement — orphan subscription_id fails.
 *   5. Cascade delete — removing the parent subscription removes the row.
 *   6. Expected indexes are present.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';

const DB_PATH = '/tmp/lootgoblin-t1-gdrive-channels.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

function now(): Date {
  return new Date();
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'GDrive Channels Test User',
    email: `${id}@gdrive-test.example`,
    emailVerified: false,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

async function seedSubscription(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistSubscriptions).values({
    id,
    ownerId,
    kind: 'folder_watch',
    sourceAdapterId: 'google-drive',
    parameters: JSON.stringify({ kind: 'folder_watch', folderId: 'gdrive-folder-1' }),
    cadenceSeconds: 3600,
    active: 1,
    errorStreak: 0,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

async function seedChannel(opts: {
  subscriptionId: string;
  channelId?: string;
  status?: 'active' | 'refreshing' | 'expired' | 'error';
}): Promise<string> {
  const id = uid();
  await db().insert(schema.gdriveWatchChannels).values({
    id,
    subscriptionId: opts.subscriptionId,
    channelId: opts.channelId ?? `channel-${id.slice(0, 8)}`,
    resourceId: `resource-${id.slice(0, 8)}`,
    resourceType: 'changes',
    address: 'https://example.test/api/v1/watchlist/gdrive/notification',
    token: crypto.randomBytes(32).toString('hex'),
    expirationMs: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    status: opts.status ?? 'active',
  });
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2-004b-T1 gdrive_watch_channels schema migration', () => {
  it('1. migrations applied — gdrive_watch_channels table exists', () => {
    const sqlite = (db() as unknown as {
      $client: { prepare: (s: string) => { all: () => Array<{ name: string }> } };
    }).$client;
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='gdrive_watch_channels'",
      )
      .all();
    expect(tables.map((t) => t.name)).toEqual(['gdrive_watch_channels']);
  });

  it('2. inserts and retrieves a channel row with all columns round-tripping', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const id = await seedChannel({ subscriptionId, channelId: 'channel-roundtrip' });

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.id, id));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.subscriptionId).toBe(subscriptionId);
    expect(row.channelId).toBe('channel-roundtrip');
    expect(row.resourceType).toBe('changes');
    expect(row.status).toBe('active');
    expect(row.token.length).toBe(64); // 32 bytes hex
    expect(row.expirationMs).toBeInstanceOf(Date);
    expect(row.errorReason).toBeNull();
    expect(row.refreshedAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('3. UNIQUE index on channel_id rejects duplicate inserts', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    await seedChannel({ subscriptionId, channelId: 'channel-dup' });

    let threw = false;
    try {
      await seedChannel({ subscriptionId, channelId: 'channel-dup' });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/UNIQUE|unique/i);
    }
    expect(threw).toBe(true);
  });

  it('4. FK enforcement — orphan subscription_id rejected', async () => {
    let threw = false;
    try {
      await db().insert(schema.gdriveWatchChannels).values({
        id: uid(),
        subscriptionId: 'no-such-subscription',
        channelId: `channel-${uid().slice(0, 8)}`,
        resourceId: 'r',
        resourceType: 'changes',
        address: 'https://example.test/n',
        token: 'x'.repeat(64),
        expirationMs: new Date(Date.now() + 86_400_000),
        status: 'active',
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);
    }
    expect(threw).toBe(true);
  });

  it('5. cascade delete — removing the subscription removes the channel', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const channelRowId = await seedChannel({ subscriptionId, channelId: 'channel-cascade' });

    await db()
      .delete(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.id, subscriptionId));

    const remaining = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.id, channelRowId));
    expect(remaining.length).toBe(0);
  });

  it('6. expected indexes are present', () => {
    const sqlite = (db() as unknown as {
      $client: { prepare: (s: string) => { all: () => Array<{ name: string }> } };
    }).$client;

    const idx = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='gdrive_watch_channels'",
      )
      .all()
      .map((r) => r.name);

    expect(idx).toEqual(
      expect.arrayContaining([
        'gdrive_watch_channels_subscription_idx',
        'gdrive_watch_channels_channel_id_uniq',
        'gdrive_watch_channels_expiration_idx',
        'gdrive_watch_channels_status_idx',
      ]),
    );
  });
});
