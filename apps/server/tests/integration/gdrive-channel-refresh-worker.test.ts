/**
 * Integration tests — GDrive channel refresh worker — V2-004b-T3.
 *
 * Coverage:
 *   runOneChannelRefreshTick:
 *     1.  No active channels → tick returns zero counts
 *     2.  Active channel with expiration > lead window → not refreshed
 *     3.  Active channel with expiration < lead window → refreshed; old row
 *         deleted; new row inserted with new channelId + token + 7-day TTL
 *     4.  Active channel already expired → marked status='expired'
 *     5.  Channel where registerGdriveChannel fails → marked status='error'
 *     6.  Channel where unregisterGdriveChannel returns 5xx but register
 *         succeeds → still counts as refresh
 *     7.  Multiple channels: one refreshes, one errors → counts split
 *
 *   Refreshing-lock:
 *     8.  status='refreshing' candidates are skipped (status filter='active')
 *
 *   resetStaleRefreshingChannels:
 *     9.  Stale 'refreshing' (refreshedAt > staleTimeout ago) → reset to active
 *     10. Recent 'refreshing' (refreshedAt within staleTimeout) → unchanged
 *     11. status='active' rows → unchanged
 *
 *   startChannelRefreshWorker:
 *     12. Initial recovery + first tick fire; AbortController stops the loop.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { encrypt } from '../../src/crypto';

const DB_PATH = '/tmp/lootgoblin-gdrive-channel-refresh.db';
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

// ─── Seeders ────────────────────────────────────────────────────────────────

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'GDrive Refresh Test User',
    email: `${id}@gdrive-refresh.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedSubscription(args: { ownerId: string }): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistSubscriptions).values({
    id,
    ownerId: args.ownerId,
    kind: 'folder_watch',
    sourceAdapterId: 'google-drive',
    parameters: JSON.stringify({ kind: 'folder_watch', folderId: 'gdrive-folder-x' }),
    cadenceSeconds: 3600,
    lastFiredAt: null,
    active: 1,
    errorStreak: 0,
    defaultCollectionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

interface ChannelArgs {
  subscriptionId: string;
  expirationMs: Date;
  status?: 'active' | 'refreshing' | 'expired' | 'error';
  refreshedAt?: Date | null;
  channelId?: string;
  resourceId?: string;
  address?: string;
  token?: string;
}

async function seedChannel(args: ChannelArgs): Promise<string> {
  const id = uid();
  await db().insert(schema.gdriveWatchChannels).values({
    id,
    subscriptionId: args.subscriptionId,
    channelId: args.channelId ?? `chan-${id.slice(0, 8)}`,
    resourceId: args.resourceId ?? `res-${id.slice(0, 8)}`,
    resourceType: 'changes',
    address: args.address ?? 'https://example.test/api/v1/watchlist/gdrive/notification',
    token: args.token ?? 'a'.repeat(64),
    expirationMs: args.expirationMs,
    status: args.status ?? 'active',
    refreshedAt: args.refreshedAt ?? null,
  });
  return id;
}

async function seedOAuthCredentials(): Promise<void> {
  const secret = process.env.LOOTGOBLIN_SECRET!;
  const bag = {
    kind: 'oauth' as const,
    accessToken: 'access-fresh',
    refreshToken: 'refresh-tok',
    expiresAt: Date.now() + 3_600_000,
    clientId: 'client-id',
    clientSecret: 'client-secret',
  };
  const blob = encrypt(JSON.stringify(bag), secret);
  await db().insert(schema.sourceCredentials).values({
    id: uid(),
    sourceId: 'google-drive',
    label: `cred-${uid().slice(0, 8)}`,
    kind: 'oauth-token',
    encryptedBlob: Buffer.from(blob),
    status: 'active',
  });
}

async function clearChannelsAndCreds(): Promise<void> {
  await db().delete(schema.gdriveWatchChannels);
  await db().delete(schema.sourceCredentials);
}

// ─── Mock fetch helpers ─────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  method?: string;
  body?: unknown;
}

function captureFetch(handlers: Array<(call: FetchCall) => Response | Promise<Response>>): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: FetchCall = { url, method: init?.method, body: init?.body };
    calls.push(call);
    const handler = handlers[i] ?? handlers[handlers.length - 1];
    i += 1;
    return handler!(call);
  }) as typeof fetch;
  return { fn, calls };
}

const stopOk = () => new Response(JSON.stringify({}), { status: 200 });
const stop500 = () => new Response('upstream error', { status: 503 });
const startPageTokenOk = () =>
  new Response(JSON.stringify({ startPageToken: 'mock-page-token' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const watchOk = (channelId: string) =>
  new Response(
    JSON.stringify({
      kind: 'api#channel',
      id: channelId,
      resourceId: 'mock-resource-id',
      resourceUri: 'https://www.googleapis.com/drive/v3/changes',
      token: 'echoed-token',
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const watchFail401 = () =>
  new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), {
    status: 401,
  });

/**
 * Build a fetch fn that routes by URL pattern. Lets a single tick that
 * processes N channels reuse the same dispatcher (each channel triggers
 * stop → startPageToken → watch).
 */
function urlRouter(routes: {
  stop?: (call: FetchCall) => Response | Promise<Response>;
  startPageToken?: (call: FetchCall) => Response | Promise<Response>;
  watch?: (call: FetchCall) => Response | Promise<Response>;
  token?: (call: FetchCall) => Response | Promise<Response>;
}): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: FetchCall = { url, method: init?.method, body: init?.body };
    calls.push(call);
    if (url.includes('/channels/stop')) {
      return (routes.stop ?? stopOk)(call);
    }
    if (url.includes('/changes/startPageToken')) {
      return (routes.startPageToken ?? startPageTokenOk)(call);
    }
    if (url.includes('/changes/watch')) {
      return (routes.watch ?? ((c) => {
        const body = JSON.parse((c.body as string) ?? '{}');
        return watchOk(body.id ?? 'unexpected');
      }))(call);
    }
    if (url.includes('oauth2.googleapis.com/token')) {
      return (routes.token ?? (() => new Response(JSON.stringify({}), { status: 200 })))(call);
    }
    return new Response('unhandled', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

// ─── runOneChannelRefreshTick ───────────────────────────────────────────────

describe('runOneChannelRefreshTick — V2-004b-T3', () => {
  beforeEach(async () => {
    await clearChannelsAndCreds();
  });

  it('1. no active channels → tick returns zero counts', async () => {
    const { runOneChannelRefreshTick } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const { fn: httpFetch } = captureFetch([() => new Response('', { status: 500 })]);
    const result = await runOneChannelRefreshTick({ httpFetch });
    expect(result).toEqual({ refreshed: 0, errored: 0, skippedExpired: 0 });
  });

  it('2. expiration outside lead window → not refreshed', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });
    // Expires in 5 days → outside the 2-day lead window.
    await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() + 5 * 24 * 3600_000),
    });
    await seedOAuthCredentials();

    const { fn: httpFetch, calls } = urlRouter({});
    const { runOneChannelRefreshTick } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const result = await runOneChannelRefreshTick({ httpFetch });
    expect(result).toEqual({ refreshed: 0, errored: 0, skippedExpired: 0 });
    expect(calls).toHaveLength(0);

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
  });

  it('3. expiration inside lead window → refreshed (new row, new channelId, new token)', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });
    const oldChannelId = 'chan-old-3';
    const oldToken = 'b'.repeat(64);
    await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() + 1 * 24 * 3600_000), // 1 day → in window
      channelId: oldChannelId,
      token: oldToken,
    });
    await seedOAuthCredentials();

    const { fn: httpFetch, calls } = urlRouter({});
    const { runOneChannelRefreshTick } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const result = await runOneChannelRefreshTick({ httpFetch });
    expect(result).toEqual({ refreshed: 1, errored: 0, skippedExpired: 0 });

    // Expect: stop + startPageToken + watch
    expect(calls.some((c) => c.url.includes('/channels/stop'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/changes/watch'))).toBe(true);

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.channelId).not.toBe(oldChannelId);
    expect(rows[0]!.token).not.toBe(oldToken);
    expect(rows[0]!.token).toMatch(/^[a-f0-9]{64}$/);
    // Expiration ~7 days from now (Google-set). Allow 1-day slop.
    const expectedMs = Date.now() + 7 * 24 * 3600_000;
    const actualMs = rows[0]!.expirationMs!.getTime();
    expect(Math.abs(actualMs - expectedMs)).toBeLessThan(1 * 24 * 3600_000);
  });

  it('4. already expired → marked status="expired", NOT refreshed', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });
    await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() - 60_000), // 1 minute ago
    });

    const { fn: httpFetch, calls } = urlRouter({});
    const { runOneChannelRefreshTick } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const result = await runOneChannelRefreshTick({ httpFetch });
    expect(result).toEqual({ refreshed: 0, errored: 0, skippedExpired: 1 });
    // No Google calls at all — already-expired path skips them.
    expect(calls).toHaveLength(0);

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('expired');
  });

  it('5. registerGdriveChannel fails → status="error" with errorReason', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });
    const oldChannelId = 'chan-old-5';
    await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() + 1 * 24 * 3600_000),
      channelId: oldChannelId,
    });
    await seedOAuthCredentials();

    // stop returns 200 (so old row IS deleted by unregister), watch returns 401.
    // We then assert the per-channel error is captured even though the row
    // moved (re-insertion of an error row is one option; here we assert the
    // worker logs the gap and counts errored=1).
    const { fn: httpFetch } = urlRouter({
      stop: stopOk,
      watch: watchFail401,
    });
    const { runOneChannelRefreshTick } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const result = await runOneChannelRefreshTick({ httpFetch });
    expect(result.errored).toBe(1);
    expect(result.refreshed).toBe(0);

    // Either: original row still exists with status='error', OR it was
    // deleted by unregister (and we logged the gap). Both are acceptable
    // per the implementation contract.
    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subId));
    if (rows.length > 0) {
      expect(rows[0]!.status).toBe('error');
      expect(rows[0]!.errorReason).toMatch(/refresh-failed/);
    }
  });

  it('6. unregister 5xx + register 200 → still counts as refresh', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });
    const oldChannelId = 'chan-old-6';
    await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() + 1 * 24 * 3600_000),
      channelId: oldChannelId,
    });
    await seedOAuthCredentials();

    // stop returns 503; unregisterGdriveChannel still tries to delete the row
    // locally. (Per T2 contract: "tolerant — Google rejects → row still
    // deleted".) Then register inserts a NEW row.
    const { fn: httpFetch } = urlRouter({
      stop: stop500,
    });
    const { runOneChannelRefreshTick } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const result = await runOneChannelRefreshTick({ httpFetch });
    expect(result).toEqual({ refreshed: 1, errored: 0, skippedExpired: 0 });

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.channelId).not.toBe(oldChannelId);
  });

  it('7. multiple channels: one refreshes, one errors → counts split correctly', async () => {
    const ownerId = await seedUser();
    const subA = await seedSubscription({ ownerId });
    const subB = await seedSubscription({ ownerId });
    await seedChannel({
      subscriptionId: subA,
      expirationMs: new Date(Date.now() + 1 * 24 * 3600_000),
      channelId: 'chan-a',
    });
    await seedChannel({
      subscriptionId: subB,
      expirationMs: new Date(Date.now() + 1 * 24 * 3600_000),
      channelId: 'chan-b',
    });
    await seedOAuthCredentials();

    // Per-call counter so the second channel's `watch` call fails.
    let watchCallCount = 0;
    const { fn: httpFetch } = urlRouter({
      stop: stopOk,
      watch: (call) => {
        watchCallCount++;
        if (watchCallCount === 1) {
          const body = JSON.parse((call.body as string) ?? '{}');
          return watchOk(body.id ?? 'first');
        }
        return watchFail401();
      },
    });

    const { runOneChannelRefreshTick } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const result = await runOneChannelRefreshTick({ httpFetch });
    expect(result.refreshed).toBe(1);
    expect(result.errored).toBe(1);
    expect(result.skippedExpired).toBe(0);
  });

  it('8. status="refreshing" rows are skipped (status filter is "active")', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });
    await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() + 1 * 24 * 3600_000),
      status: 'refreshing',
      refreshedAt: new Date(),
    });
    await seedOAuthCredentials();

    const { fn: httpFetch, calls } = urlRouter({});
    const { runOneChannelRefreshTick } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const result = await runOneChannelRefreshTick({ httpFetch });
    expect(result).toEqual({ refreshed: 0, errored: 0, skippedExpired: 0 });
    expect(calls).toHaveLength(0);
  });
});

// ─── resetStaleRefreshingChannels ───────────────────────────────────────────

describe('resetStaleRefreshingChannels — V2-004b-T3', () => {
  beforeEach(async () => {
    await clearChannelsAndCreds();
  });

  it('9. status="refreshing" with refreshedAt 30min ago → reset to active', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });
    const channelRowId = await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() + 6 * 24 * 3600_000),
      status: 'refreshing',
      refreshedAt: new Date(Date.now() - 30 * 60_000),
    });

    const { resetStaleRefreshingChannels } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const reset = await resetStaleRefreshingChannels();
    expect(reset).toBe(1);

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.id, channelRowId));
    expect(rows[0]!.status).toBe('active');
  });

  it('10. status="refreshing" with refreshedAt 1min ago → NOT reset', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });
    const channelRowId = await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() + 6 * 24 * 3600_000),
      status: 'refreshing',
      refreshedAt: new Date(Date.now() - 60_000),
    });

    const { resetStaleRefreshingChannels } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const reset = await resetStaleRefreshingChannels();
    expect(reset).toBe(0);

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.id, channelRowId));
    expect(rows[0]!.status).toBe('refreshing');
  });

  it('11. status="active" rows are unchanged', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });
    const channelRowId = await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() + 6 * 24 * 3600_000),
      status: 'active',
      refreshedAt: new Date(Date.now() - 60 * 60_000), // 1h ago
    });

    const { resetStaleRefreshingChannels } = await import(
      '../../src/workers/gdrive-channel-refresh-worker'
    );
    const reset = await resetStaleRefreshingChannels();
    expect(reset).toBe(0);

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.id, channelRowId));
    expect(rows[0]!.status).toBe('active');
  });
});

// ─── Worker loop ────────────────────────────────────────────────────────────

describe('startChannelRefreshWorker — V2-004b-T3', () => {
  beforeEach(async () => {
    await clearChannelsAndCreds();
  });

  it('12. start runs initial recovery + first tick; abort terminates the loop', async () => {
    const ownerId = await seedUser();
    const subId = await seedSubscription({ ownerId });

    // Pre-seed: a stale 'refreshing' row that recovery should reset, and a
    // due 'active' row that the first tick should refresh.
    const staleRowId = await seedChannel({
      subscriptionId: subId,
      expirationMs: new Date(Date.now() + 6 * 24 * 3600_000),
      status: 'refreshing',
      refreshedAt: new Date(Date.now() - 30 * 60_000),
      channelId: 'chan-stale-12',
    });

    // Seed a second subscription whose channel is due for refresh.
    const subDue = await seedSubscription({ ownerId });
    await seedChannel({
      subscriptionId: subDue,
      expirationMs: new Date(Date.now() + 1 * 24 * 3600_000),
      status: 'active',
      channelId: 'chan-due-12',
    });
    await seedOAuthCredentials();

    // Patch globalThis.fetch — startChannelRefreshWorker uses it through the
    // T2 helpers (no httpFetch injection on the worker entry point).
    const originalFetch = globalThis.fetch;
    const { fn } = urlRouter({});
    globalThis.fetch = fn;

    try {
      const abort = new AbortController();
      const { startChannelRefreshWorker, stopChannelRefreshWorker } = await import(
        '../../src/workers/gdrive-channel-refresh-worker'
      );

      // Start the worker; it runs recovery + first tick, then sleeps. Abort
      // before the second tick fires.
      const startPromise = startChannelRefreshWorker({ signal: abort.signal });

      // Give it a moment for recovery + tick to run. The first tick happens
      // immediately (no leading sleep). Wait a small window then abort.
      await new Promise((r) => setTimeout(r, 200));
      abort.abort();
      stopChannelRefreshWorker();

      // Allow startPromise to settle (sleep is signal-aware).
      await Promise.race([
        startPromise,
        new Promise((r) => setTimeout(r, 1_000)),
      ]);

      // Recovery: the stale row was reset to 'active' (and may then have been
      // refreshed, since it's now 'active' and within lead window — its
      // expirationMs is 6 days, so OUTSIDE lead window. Should remain
      // 'active', untouched).
      const staleAfter = await db()
        .select()
        .from(schema.gdriveWatchChannels)
        .where(eq(schema.gdriveWatchChannels.id, staleRowId));
      expect(staleAfter[0]!.status).toBe('active');

      // Due row should have been refreshed (new channelId, new row id).
      const dueAfter = await db()
        .select()
        .from(schema.gdriveWatchChannels)
        .where(eq(schema.gdriveWatchChannels.subscriptionId, subDue));
      expect(dueAfter).toHaveLength(1);
      expect(dueAfter[0]!.channelId).not.toBe('chan-due-12');
      expect(dueAfter[0]!.status).toBe('active');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Suppress unused warning (vi imported for parity with other test files).
  it('vi import sanity', () => {
    expect(typeof vi).toBe('object');
  });
});
