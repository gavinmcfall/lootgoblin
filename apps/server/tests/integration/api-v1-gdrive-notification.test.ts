/**
 * Integration tests — POST /api/v1/watchlist/gdrive/notification — V2-004b-T1 + T4.
 *
 * Real SQLite. The webhook is intentionally unauthenticated (Google needs to
 * reach it without API keys); auth is by per-channel `X-Goog-Channel-Token`
 * lookup. These tests therefore do NOT mock request-auth.
 *
 * Coverage:
 *   T1 paths (1-8):
 *   1. Missing X-Goog-Channel-ID → 401 'missing-channel-headers'
 *   2. Missing X-Goog-Channel-Token → 401 'missing-channel-headers'
 *   3. Unknown channel id → 401 'unknown-channel'
 *   4. Valid channel id + wrong token (same length) → 401 'invalid-token'
 *   5. Valid channel id + length-mismatched token → 401 'invalid-token'
 *   6. Empty token in header → 401 'missing-channel-headers' (header presence)
 *   7. Valid channel + token + 'sync' resource state → 200 + 'registration confirmed' log
 *   8. Valid channel + token + 'change' resource state → 200 + watchlist_job enqueued
 *
 *   T4 change events (9-14):
 *   9.  'change' → enqueues
 *   10. 'add' → enqueues
 *   11. 'update' → enqueues
 *   12. 'remove' → enqueues
 *   13. 'trash' → enqueues
 *   14. 'untrash' → enqueues
 *
 *   T4 no-op paths (15-20):
 *   15. paused subscription → 200, no enqueue
 *   16. existing 'queued' watchlist_job → no enqueue, last_message_number bumped
 *   17. existing 'running' watchlist_job → same
 *   18. duplicate message number (idempotent retry) → first enqueues, second no-op
 *   19. lower message number (out-of-order) → no-op
 *   20. unknown resource state → 200, no enqueue, log warn
 *
 *   Migration:
 *   21. Migration 0024 applied → schema has last_message_number column
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { eq as eqHelper } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';

// next/server NextResponse mock — supports both `.json(...)` and the
// `new NextResponse(body, init)` constructor form used by the route's
// 200-no-body path.
vi.mock('next/server', () => {
  class MockNextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
  }
  return { NextResponse: MockNextResponse };
});

// Logger spy — mock the default export shape used elsewhere (`logger.info`,
// `logger.warn`, `logger.error`).
const loggerSpies = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
vi.mock('../../src/logger', () => ({
  logger: loggerSpies,
}));

const DB_PATH = '/tmp/lootgoblin-api-gdrive-notification.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      await fsp.unlink(`${DB_PATH}${suffix}`);
    } catch {
      /* ignore */
    }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

afterAll(() => {
  // Leave DB on disk for post-mortem; the next run wipes it in beforeAll.
});

beforeEach(() => {
  loggerSpies.info.mockClear();
  loggerSpies.warn.mockClear();
  loggerSpies.error.mockClear();
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'GDrive Push Test User',
    email: `${id}@gdrive-push.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
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
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedChannel(opts: {
  subscriptionId: string;
  channelId: string;
  token: string;
}): Promise<void> {
  await db().insert(schema.gdriveWatchChannels).values({
    id: uid(),
    subscriptionId: opts.subscriptionId,
    channelId: opts.channelId,
    resourceId: `resource-${opts.channelId}`,
    resourceType: 'changes',
    address: 'https://example.test/api/v1/watchlist/gdrive/notification',
    token: opts.token,
    expirationMs: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    status: 'active',
  });
}

function makeReq(headers: Record<string, string>): Request {
  return new Request('https://example.test/api/v1/watchlist/gdrive/notification', {
    method: 'POST',
    headers,
    body: '',
  });
}

async function importPost() {
  const mod = await import('../../src/app/api/v1/watchlist/gdrive/notification/route');
  return mod.POST as (req: Request) => Promise<Response>;
}

describe('POST /api/v1/watchlist/gdrive/notification — V2-004b-T1', () => {
  it('1. returns 401 missing-channel-headers when X-Goog-Channel-ID is absent', async () => {
    const POST = await importPost();
    const res = await POST(makeReq({ 'x-goog-channel-token': 'tok' }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing-channel-headers');
  });

  it('2. returns 401 missing-channel-headers when X-Goog-Channel-Token is absent', async () => {
    const POST = await importPost();
    const res = await POST(makeReq({ 'x-goog-channel-id': 'chan-id' }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing-channel-headers');
  });

  it('3. returns 401 unknown-channel for channel ids that do not exist', async () => {
    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': 'no-such-channel',
        'x-goog-channel-token': 'whatever',
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown-channel');
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'no-such-channel' }),
      expect.stringContaining('unknown channel id'),
    );
  });

  it('4. returns 401 invalid-token when token of equal length differs', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const channelId = `chan-eq-${uid().slice(0, 8)}`;
    const realToken = 'a'.repeat(64);
    const wrongToken = 'b'.repeat(64);
    await seedChannel({ subscriptionId, channelId, token: realToken });

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': wrongToken,
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid-token');
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId }),
      expect.stringContaining('token mismatch'),
    );
  });

  it('5. returns 401 invalid-token when supplied token is length-mismatched (constant-time guard)', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const channelId = `chan-len-${uid().slice(0, 8)}`;
    const realToken = 'a'.repeat(64);
    const shortToken = 'a'.repeat(8);
    await seedChannel({ subscriptionId, channelId, token: realToken });

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': shortToken,
      }),
    );
    // Same response shape as the equal-length wrong-token case — confirms
    // we never throw on length-mismatch and reject identically.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid-token');
  });

  it('6. returns 401 missing-channel-headers when token header is empty', async () => {
    // Empty string is falsy — Headers preserves it but the route's null
    // check coerces falsy to missing.
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const channelId = `chan-empty-${uid().slice(0, 8)}`;
    await seedChannel({ subscriptionId, channelId, token: 'x'.repeat(64) });

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': '',
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing-channel-headers');
  });

  it('7. returns 200 and logs registration-confirmed for X-Goog-Resource-State: sync', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const channelId = `chan-sync-${uid().slice(0, 8)}`;
    const token = crypto.randomBytes(32).toString('hex');
    await seedChannel({ subscriptionId, channelId, token });

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': token,
        'x-goog-resource-state': 'sync',
        'x-goog-resource-id': 'res-1',
        'x-goog-message-number': '1',
      }),
    );
    expect(res.status).toBe(200);
    expect(loggerSpies.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelId, subscriptionId }),
      expect.stringContaining('sync (registration confirmed)'),
    );
  });

  it('8. returns 200 and enqueues a watchlist_job for X-Goog-Resource-State: change', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const channelId = `chan-change-${uid().slice(0, 8)}`;
    const token = crypto.randomBytes(32).toString('hex');
    await seedChannel({ subscriptionId, channelId, token });

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': token,
        'x-goog-resource-state': 'change',
        'x-goog-resource-id': 'res-42',
        'x-goog-message-number': '7',
      }),
    );
    expect(res.status).toBe(200);

    // watchlist_job exists with status='queued'.
    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eqHelper(schema.watchlistJobs.subscriptionId, subscriptionId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('queued');

    // last_message_number advanced.
    const ch = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eqHelper(schema.gdriveWatchChannels.channelId, channelId));
    expect(ch[0].lastMessageNumber).toBe(7);
  });

  // ─── T4: change-event resource states ────────────────────────────────────
  // Each of these is a change-flavored push that MUST enqueue a watchlist_job.
  // We use distinct channel ids + subscriptions per test so they can run in
  // any order without bleed.
  for (const [idx, state] of [
    [9, 'change'],
    [10, 'add'],
    [11, 'update'],
    [12, 'remove'],
    [13, 'trash'],
    [14, 'untrash'],
  ] as Array<[number, string]>) {
    it(`${idx}. enqueues a watchlist_job for X-Goog-Resource-State: ${state}`, async () => {
      const ownerId = await seedUser();
      const subscriptionId = await seedSubscription(ownerId);
      const channelId = `chan-${state}-${uid().slice(0, 8)}`;
      const token = crypto.randomBytes(32).toString('hex');
      await seedChannel({ subscriptionId, channelId, token });

      const POST = await importPost();
      const res = await POST(
        makeReq({
          'x-goog-channel-id': channelId,
          'x-goog-channel-token': token,
          'x-goog-resource-state': state,
          'x-goog-resource-id': `res-${state}`,
          'x-goog-message-number': '1',
        }),
      );
      expect(res.status).toBe(200);

      const jobs = await db()
        .select()
        .from(schema.watchlistJobs)
        .where(eqHelper(schema.watchlistJobs.subscriptionId, subscriptionId));
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('queued');
    });
  }

  // ─── T4: no-op paths ─────────────────────────────────────────────────────

  it('15. drops push when subscription is paused (active=0) — 200, no enqueue', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    // Pause the subscription.
    await db()
      .update(schema.watchlistSubscriptions)
      .set({ active: 0, updatedAt: new Date() })
      .where(eqHelper(schema.watchlistSubscriptions.id, subscriptionId));

    const channelId = `chan-paused-${uid().slice(0, 8)}`;
    const token = crypto.randomBytes(32).toString('hex');
    await seedChannel({ subscriptionId, channelId, token });

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': token,
        'x-goog-resource-state': 'change',
        'x-goog-message-number': '5',
      }),
    );
    expect(res.status).toBe(200);

    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eqHelper(schema.watchlistJobs.subscriptionId, subscriptionId));
    expect(jobs).toHaveLength(0);

    expect(loggerSpies.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelId, subscriptionId }),
      expect.stringContaining('subscription paused'),
    );
  });

  it('16. skips enqueue when a queued watchlist_job already exists — bumps last_message_number', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    // Pre-seed a queued watchlist_job.
    const existingJobId = uid();
    await db().insert(schema.watchlistJobs).values({
      id: existingJobId,
      subscriptionId,
      status: 'queued',
      itemsDiscovered: 0,
      itemsEnqueued: 0,
      createdAt: new Date(),
    });

    const channelId = `chan-queued-${uid().slice(0, 8)}`;
    const token = crypto.randomBytes(32).toString('hex');
    await seedChannel({ subscriptionId, channelId, token });

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': token,
        'x-goog-resource-state': 'change',
        'x-goog-message-number': '42',
      }),
    );
    expect(res.status).toBe(200);

    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eqHelper(schema.watchlistJobs.subscriptionId, subscriptionId));
    // Still just the pre-seeded one — no new enqueue.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(existingJobId);

    // last_message_number bumped despite no enqueue.
    const ch = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eqHelper(schema.gdriveWatchChannels.channelId, channelId));
    expect(ch[0].lastMessageNumber).toBe(42);
  });

  it('17. skips enqueue when a running watchlist_job already exists', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    await db().insert(schema.watchlistJobs).values({
      id: uid(),
      subscriptionId,
      status: 'running',
      itemsDiscovered: 0,
      itemsEnqueued: 0,
      createdAt: new Date(),
      claimedAt: new Date(),
      startedAt: new Date(),
    });

    const channelId = `chan-running-${uid().slice(0, 8)}`;
    const token = crypto.randomBytes(32).toString('hex');
    await seedChannel({ subscriptionId, channelId, token });

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': token,
        'x-goog-resource-state': 'change',
        'x-goog-message-number': '99',
      }),
    );
    expect(res.status).toBe(200);

    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eqHelper(schema.watchlistJobs.subscriptionId, subscriptionId));
    expect(jobs).toHaveLength(1); // only the pre-seeded running one
    expect(jobs[0].status).toBe('running');
  });

  it('18. drops a duplicate message_number (idempotent retry)', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const channelId = `chan-dup-${uid().slice(0, 8)}`;
    const token = crypto.randomBytes(32).toString('hex');
    await seedChannel({ subscriptionId, channelId, token });

    const POST = await importPost();
    const headers = {
      'x-goog-channel-id': channelId,
      'x-goog-channel-token': token,
      'x-goog-resource-state': 'change',
      'x-goog-message-number': '55',
    };
    const r1 = await POST(makeReq(headers));
    expect(r1.status).toBe(200);
    const r2 = await POST(makeReq(headers));
    expect(r2.status).toBe(200);

    // After the first call enqueued, the second is suppressed both by the
    // dedup check AND by the in-flight check. Either way: only one job.
    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eqHelper(schema.watchlistJobs.subscriptionId, subscriptionId));
    expect(jobs).toHaveLength(1);
  });

  it('19. drops an out-of-order message_number (lower than stored)', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const channelId = `chan-ooo-${uid().slice(0, 8)}`;
    const token = crypto.randomBytes(32).toString('hex');
    await seedChannel({ subscriptionId, channelId, token });

    // Set a stored last_message_number=10 directly (simulate prior accepts).
    await db()
      .update(schema.gdriveWatchChannels)
      .set({ lastMessageNumber: 10 })
      .where(eqHelper(schema.gdriveWatchChannels.channelId, channelId));

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': token,
        'x-goog-resource-state': 'change',
        'x-goog-message-number': '3',
      }),
    );
    expect(res.status).toBe(200);

    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eqHelper(schema.watchlistJobs.subscriptionId, subscriptionId));
    expect(jobs).toHaveLength(0);

    // last_message_number must NOT regress.
    const ch = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eqHelper(schema.gdriveWatchChannels.channelId, channelId));
    expect(ch[0].lastMessageNumber).toBe(10);
  });

  it('20. logs warn + no-op for unknown resource states (forward-compat)', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId);
    const channelId = `chan-unk-${uid().slice(0, 8)}`;
    const token = crypto.randomBytes(32).toString('hex');
    await seedChannel({ subscriptionId, channelId, token });

    const POST = await importPost();
    const res = await POST(
      makeReq({
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': token,
        'x-goog-resource-state': 'futureverb',
        'x-goog-message-number': '1',
      }),
    );
    expect(res.status).toBe(200);

    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eqHelper(schema.watchlistJobs.subscriptionId, subscriptionId));
    expect(jobs).toHaveLength(0);

    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId, resourceState: 'futureverb' }),
      expect.stringContaining('unknown resource state'),
    );
  });

  // ─── T4: migration 0024 ──────────────────────────────────────────────────

  it('21. migration 0024 added last_message_number column to gdrive_watch_channels', async () => {
    // Read PRAGMA table_info via the underlying better-sqlite3 driver.
    const native = (db() as unknown as { $client: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } }).$client;
    const cols = native
      .prepare('PRAGMA table_info(gdrive_watch_channels)')
      .all();
    const names = cols.map((c) => c.name);
    expect(names).toContain('last_message_number');
  });
});
