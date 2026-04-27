/**
 * Integration tests — GDrive watch channel registration — V2-004b-T2.
 *
 * Coverage:
 *   registerGdriveChannel:
 *     1.  Happy path — OAuth creds + mock 200 → row inserted
 *     2.  oauth-required when no source_credentials row
 *     3.  oauth-required when api-key-only credentials
 *     4.  subscription-mismatch when subscription not found
 *     5.  subscription-mismatch when wrong kind
 *     6.  subscription-mismatch when wrong source_adapter
 *     7.  registration-failed when changes.watch returns 401
 *     8.  registration-failed when changes.watch returns 500
 *
 *   unregisterGdriveChannel:
 *     9.  Happy path — DB row deleted + Google called
 *     10. Idempotent — channel doesn't exist locally → ok=true
 *     11. Tolerant — Google 410 → row still deleted
 *
 *   expireGdriveChannel:
 *     12. Marks row status='expired' without calling Google
 *
 *   Route wiring (POST/DELETE/pause/resume):
 *     13. POST /watchlist/subscriptions folder_watch+gdrive → channel registered
 *     14. POST without INSTANCE_PUBLIC_URL → no channel (info logged)
 *     15. POST creator+cults3d → no channel
 *     16. DELETE → channel rows removed
 *     17. POST /pause → channel marked expired
 *     18. POST /resume → channel re-registered
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { encrypt } from '../../src/crypto';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

const mockAuthenticate = vi.fn();
vi.mock('../../src/auth/request-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

const DB_PATH = '/tmp/lootgoblin-gdrive-channel-register.db';
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
    name: 'GDrive Channel Test User',
    email: `${id}@gdrive-chan.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashAndCollection(ownerId: string): Promise<string> {
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: `Root-${stashRootId.slice(0, 8)}`,
    path: `/tmp/lg-channel-stash-${stashRootId.slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `Col-${collectionId.slice(0, 8)}`,
    pathTemplate: '{title}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return collectionId;
}

async function seedSubscription(args: {
  ownerId: string;
  kind?: string;
  sourceAdapterId?: string;
  parameters?: Record<string, unknown>;
  active?: 0 | 1;
  defaultCollectionId?: string | null;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistSubscriptions).values({
    id,
    ownerId: args.ownerId,
    kind: args.kind ?? 'folder_watch',
    sourceAdapterId: args.sourceAdapterId ?? 'google-drive',
    parameters: JSON.stringify(
      args.parameters ?? { kind: 'folder_watch', folderId: 'gdrive-folder-1' },
    ),
    cadenceSeconds: 3600,
    lastFiredAt: null,
    active: args.active ?? 1,
    errorStreak: 0,
    defaultCollectionId: args.defaultCollectionId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

interface OAuthBag {
  kind: 'oauth' | 'oauth+api-key' | 'api-key';
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  oauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    clientId: string;
    clientSecret: string;
  };
}

function buildOAuthBag(opts: { expiresInMs?: number } = {}): OAuthBag {
  return {
    kind: 'oauth',
    accessToken: 'access-fresh',
    refreshToken: 'refresh-tok',
    expiresAt: Date.now() + (opts.expiresInMs ?? 3_600_000),
    clientId: 'client-id',
    clientSecret: 'client-secret',
  };
}

async function seedCredentials(opts: {
  sourceId?: string;
  bag: OAuthBag;
}): Promise<void> {
  const secret = process.env.LOOTGOBLIN_SECRET!;
  const blob = encrypt(JSON.stringify(opts.bag), secret);
  await db().insert(schema.sourceCredentials).values({
    id: uid(),
    sourceId: opts.sourceId ?? 'google-drive',
    label: `cred-${uid().slice(0, 8)}`,
    kind: opts.bag.kind === 'api-key' ? 'api-key' : 'oauth-token',
    encryptedBlob: Buffer.from(blob),
    status: 'active',
  });
}

async function clearCredentials(): Promise<void> {
  await db().delete(schema.sourceCredentials);
}

// ─── Mock fetch helpers ─────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function captureFetch(handlers: Array<(call: FetchCall) => Response | Promise<Response>>): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: FetchCall = {
      url,
      method: init?.method,
      body: init?.body,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    const handler = handlers[i] ?? handlers[handlers.length - 1];
    i += 1;
    return handler!(call);
  }) as typeof fetch;
  return { fn, calls };
}

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

const startPageTokenOk = () =>
  new Response(JSON.stringify({ startPageToken: 'mock-page-token' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// ─── registerGdriveChannel ──────────────────────────────────────────────────

describe('registerGdriveChannel — V2-004b-T2', () => {
  beforeEach(async () => {
    await clearCredentials();
  });

  it('1. happy path — inserts a row with the watch response data', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });
    await seedCredentials({ bag: buildOAuthBag() });

    const { fn: httpFetch, calls } = captureFetch([
      // First call: changes/startPageToken
      () => startPageTokenOk(),
      // Second call: changes/watch
      (call) => {
        // Capture channelId echo
        const body = JSON.parse((call.body as string) ?? '{}');
        return watchOk(body.id ?? 'unexpected-id');
      },
    ]);

    const { registerGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await registerGdriveChannel(
      {
        subscriptionId,
        ownerId,
        webhookAddress: 'https://example.test/api/v1/watchlist/gdrive/notification',
      },
      { httpFetch },
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain('/changes/startPageToken');
    expect(calls[1]?.url).toContain('/changes/watch?pageToken=mock-page-token');

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.resourceId).toBe('mock-resource-id');
    expect(rows[0]!.address).toBe(
      'https://example.test/api/v1/watchlist/gdrive/notification',
    );
    expect(rows[0]!.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('2. oauth-required when no source_credentials row', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });

    const { fn: httpFetch } = captureFetch([() => new Response('', { status: 500 })]);
    const { registerGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await registerGdriveChannel(
      {
        subscriptionId,
        ownerId,
        webhookAddress: 'https://example.test/api/v1/watchlist/gdrive/notification',
      },
      { httpFetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('oauth-required');
    }
  });

  it('3. oauth-required when api-key-only credentials', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });
    await seedCredentials({
      bag: { kind: 'api-key', apiKey: 'AIza-fake' },
    });

    const { fn: httpFetch } = captureFetch([() => new Response('', { status: 500 })]);
    const { registerGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await registerGdriveChannel(
      {
        subscriptionId,
        ownerId,
        webhookAddress: 'https://example.test/api/v1/watchlist/gdrive/notification',
      },
      { httpFetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('oauth-required');
  });

  it('4. subscription-mismatch when subscription not found', async () => {
    const ownerId = await seedUser();
    const { fn: httpFetch } = captureFetch([() => new Response('', { status: 500 })]);
    const { registerGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await registerGdriveChannel(
      {
        subscriptionId: 'no-such-subscription',
        ownerId,
        webhookAddress: 'https://example.test/api/v1/watchlist/gdrive/notification',
      },
      { httpFetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('subscription-mismatch');
  });

  it('5. subscription-mismatch when subscription has wrong kind', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({
      ownerId,
      kind: 'creator',
      sourceAdapterId: 'cults3d',
      parameters: { kind: 'creator', creatorId: 'c1' },
    });
    const { fn: httpFetch } = captureFetch([() => new Response('', { status: 500 })]);
    const { registerGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await registerGdriveChannel(
      {
        subscriptionId,
        ownerId,
        webhookAddress: 'https://example.test/api/v1/watchlist/gdrive/notification',
      },
      { httpFetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('subscription-mismatch');
  });

  it('6. subscription-mismatch when source_adapter_id is not google-drive', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({
      ownerId,
      sourceAdapterId: 'sketchfab',
    });
    const { fn: httpFetch } = captureFetch([() => new Response('', { status: 500 })]);
    const { registerGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await registerGdriveChannel(
      {
        subscriptionId,
        ownerId,
        webhookAddress: 'https://example.test/api/v1/watchlist/gdrive/notification',
      },
      { httpFetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('subscription-mismatch');
  });

  it('7. registration-failed when changes.watch returns 401', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });
    await seedCredentials({ bag: buildOAuthBag() });

    const { fn: httpFetch } = captureFetch([
      () => startPageTokenOk(),
      () =>
        new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), {
          status: 401,
        }),
    ]);
    const { registerGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await registerGdriveChannel(
      {
        subscriptionId,
        ownerId,
        webhookAddress: 'https://example.test/api/v1/watchlist/gdrive/notification',
      },
      { httpFetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('registration-failed');
      expect(result.details).toMatch(/401/);
    }

    // No row inserted.
    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
    expect(rows).toHaveLength(0);
  });

  it('8. registration-failed when changes.watch returns 500', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });
    await seedCredentials({ bag: buildOAuthBag() });

    const { fn: httpFetch } = captureFetch([
      () => startPageTokenOk(),
      () => new Response('upstream error', { status: 503 }),
    ]);
    const { registerGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await registerGdriveChannel(
      {
        subscriptionId,
        ownerId,
        webhookAddress: 'https://example.test/api/v1/watchlist/gdrive/notification',
      },
      { httpFetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('registration-failed');
  });
});

// ─── unregisterGdriveChannel ────────────────────────────────────────────────

describe('unregisterGdriveChannel — V2-004b-T2', () => {
  beforeEach(async () => {
    await clearCredentials();
  });

  it('9. happy path — calls channels/stop and deletes the local row', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });
    await seedCredentials({ bag: buildOAuthBag() });

    const channelId = 'chan-9';
    await db().insert(schema.gdriveWatchChannels).values({
      id: uid(),
      subscriptionId,
      channelId,
      resourceId: 'res-9',
      resourceType: 'changes',
      address: 'https://example.test/api/v1/watchlist/gdrive/notification',
      token: 'a'.repeat(64),
      expirationMs: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      status: 'active',
    });

    const { fn: httpFetch, calls } = captureFetch([
      () => new Response(JSON.stringify({}), { status: 200 }),
    ]);
    const { unregisterGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await unregisterGdriveChannel(
      { channelId, subscriptionId },
      { httpFetch },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain('/channels/stop');

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
    expect(rows).toHaveLength(0);
  });

  it('10. idempotent — channel does not exist locally → ok', async () => {
    const { fn: httpFetch } = captureFetch([
      () => new Response('', { status: 404 }),
    ]);
    const { unregisterGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await unregisterGdriveChannel(
      { channelId: 'never-existed', subscriptionId: 'never-existed' },
      { httpFetch },
    );
    expect(result.ok).toBe(true);
  });

  it('11. tolerant — Google returns 410 → row still deleted locally', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });
    await seedCredentials({ bag: buildOAuthBag() });

    const channelId = 'chan-11';
    await db().insert(schema.gdriveWatchChannels).values({
      id: uid(),
      subscriptionId,
      channelId,
      resourceId: 'res-11',
      resourceType: 'changes',
      address: 'https://example.test/api/v1/watchlist/gdrive/notification',
      token: 'a'.repeat(64),
      expirationMs: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      status: 'active',
    });

    const { fn: httpFetch } = captureFetch([
      () =>
        new Response(JSON.stringify({ error: { code: 410, message: 'Gone' } }), {
          status: 410,
        }),
    ]);
    const { unregisterGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await unregisterGdriveChannel(
      { channelId, subscriptionId },
      { httpFetch },
    );
    expect(result.ok).toBe(true);

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
    expect(rows).toHaveLength(0);
  });
});

// ─── expireGdriveChannel ────────────────────────────────────────────────────

describe('expireGdriveChannel — V2-004b-T2', () => {
  it('12. marks status="expired" without calling Google', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });
    await db().insert(schema.gdriveWatchChannels).values({
      id: uid(),
      subscriptionId,
      channelId: 'chan-12',
      resourceId: 'res-12',
      resourceType: 'changes',
      address: 'https://example.test/api/v1/watchlist/gdrive/notification',
      token: 'a'.repeat(64),
      expirationMs: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      status: 'active',
    });

    const { expireGdriveChannel } = await import(
      '../../src/watchlist/gdrive-channels-register'
    );
    const result = await expireGdriveChannel({ subscriptionId });
    expect(result.ok).toBe(true);

    const rows = await db()
      .select()
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
    expect(rows[0]!.status).toBe('expired');
  });
});

// ─── Route wiring ───────────────────────────────────────────────────────────

function actor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

function makeReq(
  url: string,
  init: RequestInit = {},
): import('next/server').NextRequest {
  return new Request(url, init) as unknown as import('next/server').NextRequest;
}

describe('Route wiring — V2-004b-T2', () => {
  // We patch global fetch to simulate Google's API. The route layer does not
  // accept a fetch injection; using globalThis.fetch overrides is the
  // accepted pattern (T9, T10).
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    await clearCredentials();
    // Ensure each test starts from a known fetch state.
    originalFetch = globalThis.fetch;
  });

  function installFetch(
    handlers: Array<(call: FetchCall) => Response | Promise<Response>>,
  ): { calls: FetchCall[]; restore: () => void } {
    const { fn, calls } = captureFetch(handlers);
    globalThis.fetch = fn;
    return {
      calls,
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  }

  it('13. POST folder_watch+gdrive registers a channel when INSTANCE_PUBLIC_URL is set', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedStashAndCollection(ownerId);
    await seedCredentials({ bag: buildOAuthBag() });

    process.env.INSTANCE_PUBLIC_URL = 'https://lg.example.test';

    const fetchCtl = installFetch([
      () => startPageTokenOk(),
      (call) => {
        const body = JSON.parse((call.body as string) ?? '{}');
        return watchOk(body.id ?? 'unexpected');
      },
    ]);
    try {
      mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
      const { POST } = await import(
        '../../src/app/api/v1/watchlist/subscriptions/route'
      );
      const res = await POST(
        makeReq('http://local/api/v1/watchlist/subscriptions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'folder_watch',
            source_adapter_id: 'google-drive',
            parameters: { kind: 'folder_watch', folderId: 'drive-folder-13' },
            cadence_seconds: 3600,
            default_collection_id: collectionId,
          }),
        }),
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      const subscriptionId = json.subscription.id as string;

      const channels = await db()
        .select()
        .from(schema.gdriveWatchChannels)
        .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
      expect(channels).toHaveLength(1);
      expect(channels[0]!.address).toBe(
        'https://lg.example.test/api/v1/watchlist/gdrive/notification',
      );
    } finally {
      fetchCtl.restore();
      delete process.env.INSTANCE_PUBLIC_URL;
    }
  });

  it('14. POST without INSTANCE_PUBLIC_URL still creates the subscription (no channel)', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedStashAndCollection(ownerId);
    await seedCredentials({ bag: buildOAuthBag() });

    delete process.env.INSTANCE_PUBLIC_URL;
    const savedAuthUrl = process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_URL;

    // No fetch handlers needed — no channel registration should fire.
    try {
      mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
      const { POST } = await import(
        '../../src/app/api/v1/watchlist/subscriptions/route'
      );
      const res = await POST(
        makeReq('http://local/api/v1/watchlist/subscriptions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'folder_watch',
            source_adapter_id: 'google-drive',
            parameters: { kind: 'folder_watch', folderId: 'drive-folder-14' },
            cadence_seconds: 3600,
            default_collection_id: collectionId,
          }),
        }),
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      const subscriptionId = json.subscription.id as string;

      const channels = await db()
        .select()
        .from(schema.gdriveWatchChannels)
        .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
      expect(channels).toHaveLength(0);
    } finally {
      if (savedAuthUrl !== undefined) process.env.BETTER_AUTH_URL = savedAuthUrl;
    }
  });

  it('15. POST creator+cults3d does not register a channel', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedStashAndCollection(ownerId);
    process.env.INSTANCE_PUBLIC_URL = 'https://lg.example.test';

    try {
      mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
      const { POST } = await import(
        '../../src/app/api/v1/watchlist/subscriptions/route'
      );
      const res = await POST(
        makeReq('http://local/api/v1/watchlist/subscriptions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'creator',
            source_adapter_id: 'cults3d',
            parameters: { kind: 'creator', creatorId: 'creator-15' },
            cadence_seconds: 3600,
            default_collection_id: collectionId,
          }),
        }),
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      const subscriptionId = json.subscription.id as string;

      const channels = await db()
        .select()
        .from(schema.gdriveWatchChannels)
        .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
      expect(channels).toHaveLength(0);
    } finally {
      delete process.env.INSTANCE_PUBLIC_URL;
    }
  });

  it('16. DELETE unregisters the channel and removes its row', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });
    await seedCredentials({ bag: buildOAuthBag() });
    const channelId = 'chan-16';
    await db().insert(schema.gdriveWatchChannels).values({
      id: uid(),
      subscriptionId,
      channelId,
      resourceId: 'res-16',
      resourceType: 'changes',
      address: 'https://example.test/api/v1/watchlist/gdrive/notification',
      token: 'a'.repeat(64),
      expirationMs: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      status: 'active',
    });

    const fetchCtl = installFetch([
      () => new Response(JSON.stringify({}), { status: 200 }),
    ]);
    try {
      mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
      const { DELETE } = await import(
        '../../src/app/api/v1/watchlist/subscriptions/[id]/route'
      );
      const res = await DELETE(
        makeReq(`http://local/api/v1/watchlist/subscriptions/${subscriptionId}`, {
          method: 'DELETE',
        }),
        { params: Promise.resolve({ id: subscriptionId }) },
      );
      expect(res.status).toBe(204);

      const channels = await db()
        .select()
        .from(schema.gdriveWatchChannels)
        .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
      expect(channels).toHaveLength(0);
    } finally {
      fetchCtl.restore();
    }
  });

  it('17. POST /pause marks the channel expired without calling Google', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId });
    const channelId = 'chan-17';
    await db().insert(schema.gdriveWatchChannels).values({
      id: uid(),
      subscriptionId,
      channelId,
      resourceId: 'res-17',
      resourceType: 'changes',
      address: 'https://example.test/api/v1/watchlist/gdrive/notification',
      token: 'a'.repeat(64),
      expirationMs: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      status: 'active',
    });

    // Install a fetch that throws so we can catch any unexpected call.
    const fetchCtl = installFetch([
      () => {
        throw new Error('pause should NOT call Google');
      },
    ]);
    try {
      mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
      const { POST: pausePost } = await import(
        '../../src/app/api/v1/watchlist/subscriptions/[id]/pause/route'
      );
      const res = await pausePost(
        makeReq(
          `http://local/api/v1/watchlist/subscriptions/${subscriptionId}/pause`,
          { method: 'POST' },
        ),
        { params: Promise.resolve({ id: subscriptionId }) },
      );
      expect(res.status).toBe(204);

      const rows = await db()
        .select()
        .from(schema.gdriveWatchChannels)
        .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
      expect(rows[0]!.status).toBe('expired');
      expect(fetchCtl.calls).toHaveLength(0);
    } finally {
      fetchCtl.restore();
    }
  });

  it('18. POST /resume re-registers when there is an expired channel', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription({ ownerId, active: 0 });
    await seedCredentials({ bag: buildOAuthBag() });
    const oldChannelId = 'chan-18-old';
    await db().insert(schema.gdriveWatchChannels).values({
      id: uid(),
      subscriptionId,
      channelId: oldChannelId,
      resourceId: 'res-18-old',
      resourceType: 'changes',
      address: 'https://example.test/api/v1/watchlist/gdrive/notification',
      token: 'a'.repeat(64),
      expirationMs: new Date(Date.now() + 60_000),
      status: 'expired',
    });

    process.env.INSTANCE_PUBLIC_URL = 'https://lg.example.test';

    // Expected fetch sequence on resume:
    //   1. unregisterGdriveChannel → channels/stop (best-effort, accepts 410)
    //   2. registerGdriveChannel → changes/startPageToken
    //   3. registerGdriveChannel → changes/watch
    const fetchCtl = installFetch([
      // channels/stop
      () =>
        new Response(JSON.stringify({ error: { code: 410, message: 'Gone' } }), {
          status: 410,
        }),
      // startPageToken
      () => startPageTokenOk(),
      // changes.watch
      (call) => {
        const body = JSON.parse((call.body as string) ?? '{}');
        return watchOk(body.id ?? 'unexpected');
      },
    ]);
    try {
      mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
      const { POST: resumePost } = await import(
        '../../src/app/api/v1/watchlist/subscriptions/[id]/resume/route'
      );
      const res = await resumePost(
        makeReq(
          `http://local/api/v1/watchlist/subscriptions/${subscriptionId}/resume`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          },
        ),
        { params: Promise.resolve({ id: subscriptionId }) },
      );
      expect(res.status).toBe(204);

      // Old expired row gone, new active row inserted.
      const rows = await db()
        .select()
        .from(schema.gdriveWatchChannels)
        .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('active');
      expect(rows[0]!.channelId).not.toBe(oldChannelId);
    } finally {
      fetchCtl.restore();
      delete process.env.INSTANCE_PUBLIC_URL;
    }
  });
});
