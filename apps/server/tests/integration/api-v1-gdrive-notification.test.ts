/**
 * Integration tests — POST /api/v1/watchlist/gdrive/notification — V2-004b-T1.
 *
 * Real SQLite. The webhook is intentionally unauthenticated (Google needs to
 * reach it without API keys); auth is by per-channel `X-Goog-Channel-Token`
 * lookup. These tests therefore do NOT mock request-auth.
 *
 * Coverage:
 *   1. Missing X-Goog-Channel-ID → 401 'missing-channel-headers'
 *   2. Missing X-Goog-Channel-Token → 401 'missing-channel-headers'
 *   3. Unknown channel id → 401 'unknown-channel'
 *   4. Valid channel id + wrong token (same length) → 401 'invalid-token'
 *   5. Valid channel id + length-mismatched token → 401 'invalid-token'
 *   6. Empty token in header → 401 'missing-channel-headers' (header presence)
 *   7. Valid channel + token + 'sync' resource state → 200 + 'registration confirmed' log
 *   8. Valid channel + token + 'change' resource state → 200 + 'change notification' log
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';

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

  it('8. returns 200 and logs change-notification for X-Goog-Resource-State: change', async () => {
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
    expect(loggerSpies.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId,
        subscriptionId,
        resourceState: 'change',
        resourceId: 'res-42',
        messageNumber: '7',
      }),
      expect.stringContaining('change notification received'),
    );
  });
});
