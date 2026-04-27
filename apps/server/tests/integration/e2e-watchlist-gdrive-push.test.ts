/**
 * V2-004b-T5 — End-to-end GDrive push notifications
 *
 * Drives the full push pipeline through real HTTP routes:
 *
 *   POST /api/v1/watchlist/subscriptions  →  Google `changes.watch` (msw)
 *                                          →  gdrive_watch_channels row
 *   Google push  →  POST /api/v1/watchlist/gdrive/notification
 *                →  watchlist_jobs row
 *   runOneWatchlistJob  →  discovery (msw `files.list`)
 *                       →  ingest_jobs rows
 *   runOneIngestJob     →  fetch (msw `files/<id>?alt=media`)
 *                       →  Loot row
 *
 *   Channel refresh  →  runOneChannelRefreshTick
 *                    →  channels/stop + changes/watch (msw)
 *                    →  new channel row replaces the old
 *
 * Mocking surface (msw):
 *   - https://www.googleapis.com/drive/v3/changes/startPageToken (GET)
 *   - https://www.googleapis.com/drive/v3/changes/watch          (POST)
 *   - https://www.googleapis.com/drive/v3/channels/stop          (POST)
 *   - https://www.googleapis.com/drive/v3/files                  (GET listing)
 *   - https://www.googleapis.com/drive/v3/files/<id>             (GET meta + media)
 *   - https://oauth2.googleapis.com/token                        (POST refresh — unused on happy path but registered defensively)
 *
 * The route layer is exercised by importing the real `POST` / `DELETE`
 * functions and invoking them with a synthetic `Request`. `authenticateRequest`
 * is mocked to short-circuit BetterAuth/api-key parsing (the same shim used
 * across V2-004 e2e tests).
 *
 * INSTANCE_PUBLIC_URL is set in beforeAll so the subscription POST route
 * fires the registration step. Cleared in afterAll.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { eq } from 'drizzle-orm';

import {
  setupE2eDb,
  seedUser,
  seedStashRoot,
  seedCollection,
  seedSourceCredential,
  rewireAdaptersForMsw,
  wipeWatchlistE2eState,
  drainWatchlistJobs,
  drainIngestJobs,
  listIngestJobsForSubscription,
  listLootInCollection,
  listWatchlistJobs,
  actor,
  uid,
} from './_helpers/e2e';
import { getDb, schema } from '../../src/db/client';
import { runOneChannelRefreshTick } from '../../src/workers/gdrive-channel-refresh-worker';

// ---------------------------------------------------------------------------
// next/server + auth shims
// ---------------------------------------------------------------------------

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

const mockAuthenticate = vi.fn();
vi.mock('../../src/auth/request-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-t5-gdrive-push.db';
const PUBLIC_URL = 'https://test.example.com';
const FOLDER_ID = 'folder-push-1';
const server = setupServer();

let savedInstancePublicUrl: string | undefined;

beforeAll(async () => {
  await setupE2eDb(DB_PATH);
  // The subscription POST route reads INSTANCE_PUBLIC_URL synchronously to
  // build the webhook address. Set it before any route import.
  savedInstancePublicUrl = process.env.INSTANCE_PUBLIC_URL;
  process.env.INSTANCE_PUBLIC_URL = PUBLIC_URL;
  server.listen({ onUnhandledRequest: 'error' });
  rewireAdaptersForMsw();
});

afterAll(() => {
  server.close();
  if (savedInstancePublicUrl === undefined) {
    delete process.env.INSTANCE_PUBLIC_URL;
  } else {
    process.env.INSTANCE_PUBLIC_URL = savedInstancePublicUrl;
  }
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb() as DB;
}

// ---------------------------------------------------------------------------
// msw helpers — Google Drive watch + folder enumeration
// ---------------------------------------------------------------------------

interface GoogleMockState {
  /** Channel id Google "returns" on the next changes.watch POST. */
  channelId: string;
  /** Resource id Google "returns" on the next changes.watch POST. */
  resourceId: string;
  /** Expiration ms Google "returns". */
  expirationMs: number;
  /** Number of /changes/watch POSTs observed. */
  watchCalls: number;
  /** Number of /channels/stop POSTs observed. */
  stopCalls: number;
  /** Bodies of /changes/watch POSTs, parsed. */
  watchBodies: Array<Record<string, unknown>>;
}

/**
 * Install the standard set of msw handlers for the Google Drive push lifecycle.
 *
 * Returns a state object that captures the channel id Google echoed back
 * (matches what the route stores in gdrive_watch_channels.channel_id) plus
 * counts of watch/stop calls. Tests assert against this.
 */
function installGoogleHandlers(opts?: {
  channelIdOverride?: string;
  resourceIdOverride?: string;
  expirationMs?: number;
}): GoogleMockState {
  const state: GoogleMockState = {
    channelId: opts?.channelIdOverride ?? `gen-${uid().slice(0, 8)}`,
    resourceId: opts?.resourceIdOverride ?? `res-${uid().slice(0, 8)}`,
    expirationMs: opts?.expirationMs ?? Date.now() + 7 * 24 * 60 * 60 * 1000,
    watchCalls: 0,
    stopCalls: 0,
    watchBodies: [],
  };

  server.use(
    http.get(
      'https://www.googleapis.com/drive/v3/changes/startPageToken',
      () =>
        HttpResponse.json({ startPageToken: `pt-${uid().slice(0, 8)}` }),
    ),
    http.post(
      'https://www.googleapis.com/drive/v3/changes/watch',
      async ({ request }) => {
        state.watchCalls += 1;
        const body = (await request.json()) as Record<string, unknown>;
        state.watchBodies.push(body);
        // Google echoes the id we sent (registerGdriveChannel relies on this).
        const echoedId =
          typeof body['id'] === 'string' ? (body['id'] as string) : state.channelId;
        return HttpResponse.json({
          kind: 'api#channel',
          id: echoedId,
          resourceId: state.resourceId,
          resourceUri: 'https://www.googleapis.com/drive/v3/changes',
          token: typeof body['token'] === 'string' ? (body['token'] as string) : 'echoed',
          expiration: String(state.expirationMs),
        });
      },
    ),
    http.post('https://www.googleapis.com/drive/v3/channels/stop', async () => {
      state.stopCalls += 1;
      return HttpResponse.json({}, { status: 200 });
    }),
    // Defensive: never expected on the happy path because our seeded OAuth
    // bag has expiresAt in the future, but registered to avoid msw's
    // onUnhandledRequest='error' if a test happens to drift the clock.
    http.post('https://oauth2.googleapis.com/token', () =>
      HttpResponse.json({ access_token: 'refreshed', expires_in: 3600 }),
    ),
  );
  return state;
}

/**
 * Install folder enumeration mocks for the discovery pass triggered by the
 * watchlist worker. Returns nothing — the side effect is the msw handlers.
 *
 * `children` are returned by /files (folder list) and /files/<id> (metadata
 * + media). Each child gets a distinct STL body so dedup-by-hash doesn't
 * collapse them.
 */
interface DriveChild {
  id: string;
  name: string;
  modifiedTime: string;
}
function stlBodyFor(id: string): string {
  return `solid ${id}\nendsolid ${id}\n`;
}
function installFolderEnumeration(opts: {
  folderId: string;
  children: DriveChild[];
}): void {
  const handlers: Parameters<typeof server.use> = [];
  handlers.push(
    http.get('https://www.googleapis.com/drive/v3/files', () =>
      HttpResponse.json({
        files: opts.children.map((c) => ({
          id: c.id,
          name: c.name,
          mimeType: 'application/octet-stream',
          size: String(stlBodyFor(c.id).length),
          parents: [opts.folderId],
          md5Checksum: `md5-${c.id}`,
          modifiedTime: c.modifiedTime,
        })),
      }),
    ),
  );
  for (const c of opts.children) {
    handlers.push(
      http.get(
        `https://www.googleapis.com/drive/v3/files/${c.id}`,
        ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('alt') === 'media') {
            return new HttpResponse(stlBodyFor(c.id), {
              headers: { 'content-type': 'application/octet-stream' },
            });
          }
          return HttpResponse.json({
            id: c.id,
            name: c.name,
            mimeType: 'application/octet-stream',
            size: String(stlBodyFor(c.id).length),
            parents: [opts.folderId],
            md5Checksum: `md5-${c.id}`,
            modifiedTime: c.modifiedTime,
          });
        },
      ),
    );
  }
  server.use(...handlers);
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function makePost(body: unknown): import('next/server').NextRequest {
  return new Request('http://local/api/v1/watchlist/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

function makeAction(id: string, action: string): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions/${id}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }) as unknown as import('next/server').NextRequest;
}

function makeDelete(id: string): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions/${id}`, {
    method: 'DELETE',
  }) as unknown as import('next/server').NextRequest;
}

/**
 * Invoke the gdrive-notification webhook with the given X-Goog-* headers.
 * Returns the route's status + parsed body (if any). Passes through the real
 * route handler so the test exercises header parsing + the push handler.
 */
async function postGdriveNotification(opts: {
  channelId: string;
  channelToken: string;
  resourceState:
    | 'change'
    | 'add'
    | 'update'
    | 'remove'
    | 'trash'
    | 'untrash'
    | 'sync';
  resourceId?: string;
  messageNumber: number;
}): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    'x-goog-channel-id': opts.channelId,
    'x-goog-channel-token': opts.channelToken,
    'x-goog-resource-state': opts.resourceState,
    'x-goog-message-number': String(opts.messageNumber),
  };
  if (opts.resourceId) headers['x-goog-resource-id'] = opts.resourceId;

  const req = new Request(
    'https://test.example.com/api/v1/watchlist/gdrive/notification',
    { method: 'POST', headers, body: '' },
  );
  const { POST } = await import(
    '../../src/app/api/v1/watchlist/gdrive/notification/route'
  );
  const res = await POST(req as unknown as import('next/server').NextRequest);
  let body: unknown = null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    body = await res.json();
  }
  return { status: res.status, body };
}

/**
 * Seed an OAuth credential bag — required for push registration. API-key
 * credentials are rejected by `registerGdriveChannel` with `oauth-required`.
 */
async function seedGdriveOAuth(opts: { expiresInMs?: number } = {}): Promise<void> {
  await seedSourceCredential({
    sourceId: 'google-drive',
    kind: 'oauth-token',
    bag: {
      kind: 'oauth',
      accessToken: 'access-fresh',
      refreshToken: 'refresh-tok',
      expiresAt: Date.now() + (opts.expiresInMs ?? 3_600_000),
      clientId: 'client-id',
      clientSecret: 'client-secret',
    },
  });
}

/**
 * Read the (single) gdrive_watch_channels row for a subscription. Throws if
 * the row is missing — most tests want to assert a row exists first.
 */
async function getChannelRow(subscriptionId: string) {
  const rows = await db()
    .select()
    .from(schema.gdriveWatchChannels)
    .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId));
  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e — gdrive push notifications (V2-004b-T5)', () => {
  let userId: string;
  let collectionId: string;

  beforeEach(async () => {
    await wipeWatchlistE2eState();
    userId = await seedUser();
    const root = await seedStashRoot(userId);
    const col = await seedCollection(userId, root.id);
    collectionId = col.id;
    mockAuthenticate.mockResolvedValue(actor(userId));
    await seedGdriveOAuth();
  });

  // ─── 1. Full happy-path ────────────────────────────────────────────────────

  it('1. POST subscription → push → watchlist_job → discovery → ingest → Loot', async () => {
    const googleState = installGoogleHandlers();
    const children: DriveChild[] = Array.from({ length: 3 }, (_, i) => ({
      id: `c-happy-${i + 1}`,
      name: `happy-${i + 1}.stl`,
      modifiedTime: `2026-01-0${i + 1}T00:00:00Z`,
    }));
    installFolderEnumeration({ folderId: FOLDER_ID, children });

    // 1a. POST subscription → triggers registration.
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'folder_watch',
        source_adapter_id: 'google-drive',
        parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
        cadence_seconds: 3600,
        default_collection_id: collectionId,
      }),
    );
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    const subId = createBody.subscription.id as string;

    // 1b. msw observed the changes.watch POST with the right body shape.
    expect(googleState.watchCalls).toBe(1);
    const watchBody = googleState.watchBodies[0]!;
    expect(typeof watchBody['id']).toBe('string');
    expect(watchBody['type']).toBe('web_hook');
    expect(watchBody['address']).toBe(
      `${PUBLIC_URL}/api/v1/watchlist/gdrive/notification`,
    );
    expect(typeof watchBody['token']).toBe('string');
    expect(typeof watchBody['expiration']).toBe('string');

    // 1c. Channel row inserted with status='active'.
    const channelRows = await getChannelRow(subId);
    expect(channelRows).toHaveLength(1);
    const channel = channelRows[0]!;
    expect(channel.status).toBe('active');

    // 1d. POST push notification with valid headers.
    const pushRes = await postGdriveNotification({
      channelId: channel.channelId,
      channelToken: channel.token,
      resourceState: 'change',
      resourceId: 'res-happy',
      messageNumber: 1,
    });
    expect(pushRes.status).toBe(200);

    // 1e. watchlist_job enqueued for this subscription.
    const wlJobs = await listWatchlistJobs(subId, 'queued');
    expect(wlJobs).toHaveLength(1);

    // 1f. Drain workers → ingest_jobs → Loot.
    await drainWatchlistJobs();
    await drainIngestJobs();

    const ingest = await listIngestJobsForSubscription(subId);
    expect(ingest.length).toBe(3);
    for (const j of ingest) expect(j.status).toBe('completed');
    const loot = await listLootInCollection(collectionId);
    expect(loot.length).toBe(3);
  });

  // ─── 2. Sync notification ─────────────────────────────────────────────────

  it('2. sync notification on registration → 200, no watchlist_job', async () => {
    installGoogleHandlers();
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'folder_watch',
        source_adapter_id: 'google-drive',
        parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
        cadence_seconds: 3600,
        default_collection_id: collectionId,
      }),
    );
    expect(createRes.status).toBe(201);
    const subId = (await createRes.json()).subscription.id as string;

    const [channel] = await getChannelRow(subId);
    const res = await postGdriveNotification({
      channelId: channel!.channelId,
      channelToken: channel!.token,
      resourceState: 'sync',
      resourceId: 'res-sync',
      messageNumber: 1,
    });
    expect(res.status).toBe(200);

    const wlJobs = await listWatchlistJobs(subId);
    expect(wlJobs).toHaveLength(0);
  });

  // ─── 3. In-flight push deduplication ──────────────────────────────────────

  it('3. push while a watchlist_job is in flight → 200, no new job, last_message_number bumped', async () => {
    installGoogleHandlers();
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'folder_watch',
        source_adapter_id: 'google-drive',
        parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
        cadence_seconds: 3600,
        default_collection_id: collectionId,
      }),
    );
    const subId = (await createRes.json()).subscription.id as string;
    const [channel] = await getChannelRow(subId);

    // Manually enqueue a watchlist_job already in flight.
    const existingJobId = uid();
    await db().insert(schema.watchlistJobs).values({
      id: existingJobId,
      subscriptionId: subId,
      status: 'queued',
      itemsDiscovered: 0,
      itemsEnqueued: 0,
      createdAt: new Date(),
    });

    const res = await postGdriveNotification({
      channelId: channel!.channelId,
      channelToken: channel!.token,
      resourceState: 'change',
      resourceId: 'res-inflight',
      messageNumber: 12,
    });
    expect(res.status).toBe(200);

    // Still just the pre-seeded job.
    const wlJobs = await listWatchlistJobs(subId);
    expect(wlJobs).toHaveLength(1);
    expect(wlJobs[0]!.id).toBe(existingJobId);

    // last_message_number advanced.
    const [refreshed] = await getChannelRow(subId);
    expect(refreshed!.lastMessageNumber).toBe(12);
  });

  // ─── 4. Paused subscription drops push ────────────────────────────────────

  it('4. push to a paused subscription → 200, no watchlist_job, channel still expired', async () => {
    installGoogleHandlers();
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'folder_watch',
        source_adapter_id: 'google-drive',
        parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
        cadence_seconds: 3600,
        default_collection_id: collectionId,
      }),
    );
    const subId = (await createRes.json()).subscription.id as string;
    const [channel] = await getChannelRow(subId);

    // Pause via the route — flips active=0 + marks channel status='expired'.
    const { POST: pausePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/pause/route'
    );
    const pauseRes = await pausePOST(makeAction(subId, 'pause'), {
      params: Promise.resolve({ id: subId }),
    });
    expect(pauseRes.status).toBe(204);

    // Sanity: channel marked expired (T2 contract).
    const [paused] = await getChannelRow(subId);
    expect(paused!.status).toBe('expired');

    // Late push arrives — channel row still exists, route should 200 + drop.
    const res = await postGdriveNotification({
      channelId: channel!.channelId,
      channelToken: channel!.token,
      resourceState: 'change',
      resourceId: 'res-paused',
      messageNumber: 5,
    });
    expect(res.status).toBe(200);

    const wlJobs = await listWatchlistJobs(subId);
    expect(wlJobs).toHaveLength(0);

    // Status not flipped back.
    const [stillExpired] = await getChannelRow(subId);
    expect(stillExpired!.status).toBe('expired');
  });

  // ─── 5. Refresh worker rolls a near-expiring channel ─────────────────────

  it('5. runOneChannelRefreshTick → stop old + register new + only the new row remains', async () => {
    // Initial registration TTL set just inside the 2-day refresh lead window.
    const initialTtlMs = 1 * 24 * 3600_000; // 1 day from now → due
    const googleState = installGoogleHandlers({
      expirationMs: Date.now() + initialTtlMs,
    });
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'folder_watch',
        source_adapter_id: 'google-drive',
        parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
        cadence_seconds: 3600,
        default_collection_id: collectionId,
      }),
    );
    const subId = (await createRes.json()).subscription.id as string;
    const [oldChannel] = await getChannelRow(subId);
    expect(googleState.watchCalls).toBe(1);

    // Reinstall handlers so the second cycle returns a fresh 7-day TTL. The
    // channel id is generated client-side by registerGdriveChannel (UUID v4)
    // and echoed by Google — we don't override it, we just assert the new
    // row's channelId differs from the old one.
    server.resetHandlers();
    const refreshState = installGoogleHandlers({
      expirationMs: Date.now() + 7 * 24 * 3600_000,
    });

    const refreshNow = new Date();
    const result = await runOneChannelRefreshTick({ now: refreshNow });
    expect(result).toEqual({ refreshed: 1, errored: 0, skippedExpired: 0 });

    // msw saw stop + watch.
    expect(refreshState.stopCalls).toBe(1);
    expect(refreshState.watchCalls).toBe(1);

    // Exactly ONE channel row remains; channel id is fresh.
    const after = await getChannelRow(subId);
    expect(after).toHaveLength(1);
    expect(after[0]!.channelId).not.toBe(oldChannel!.channelId);
    expect(after[0]!.status).toBe('active');

    // New TTL ≈ refreshState.expirationMs (within 1 day slop).
    const expectedMs = refreshState.expirationMs;
    const actualMs = after[0]!.expirationMs!.getTime();
    expect(Math.abs(actualMs - expectedMs)).toBeLessThan(1 * 24 * 3600_000);
  });

  // ─── 6. Unregister on subscription delete + late push 401s ───────────────

  it('6. DELETE subscription → channels/stop called, row gone, late push → 401', async () => {
    const googleState = installGoogleHandlers();
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'folder_watch',
        source_adapter_id: 'google-drive',
        parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
        cadence_seconds: 3600,
        default_collection_id: collectionId,
      }),
    );
    const subId = (await createRes.json()).subscription.id as string;
    const [channel] = await getChannelRow(subId);

    // DELETE → unregister + cascade.
    const { DELETE: deleteSub } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/route'
    );
    const delRes = await deleteSub(makeDelete(subId), {
      params: Promise.resolve({ id: subId }),
    });
    expect(delRes.status).toBe(204);
    expect(googleState.stopCalls).toBe(1);

    const after = await getChannelRow(subId);
    expect(after).toHaveLength(0);

    // Late push → unknown channel.
    const res = await postGdriveNotification({
      channelId: channel!.channelId,
      channelToken: channel!.token,
      resourceState: 'change',
      resourceId: 'res-late',
      messageNumber: 99,
    });
    expect(res.status).toBe(401);
    const body = res.body as { error: string };
    expect(body.error).toBe('unknown-channel');
  });

  // ─── 7. Idempotent push retries (same message number) ───────────────────

  it('7. duplicate X-Goog-Message-Number → first enqueues, second is a no-op', async () => {
    installGoogleHandlers();
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'folder_watch',
        source_adapter_id: 'google-drive',
        parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
        cadence_seconds: 3600,
        default_collection_id: collectionId,
      }),
    );
    const subId = (await createRes.json()).subscription.id as string;
    const [channel] = await getChannelRow(subId);

    const headers = {
      channelId: channel!.channelId,
      channelToken: channel!.token,
      resourceState: 'change' as const,
      resourceId: 'res-dup',
      messageNumber: 5,
    };

    const r1 = await postGdriveNotification(headers);
    expect(r1.status).toBe(200);
    const after1 = await listWatchlistJobs(subId);
    expect(after1).toHaveLength(1);

    const r2 = await postGdriveNotification(headers);
    expect(r2.status).toBe(200);
    const after2 = await listWatchlistJobs(subId);
    // Either dedup-by-message-number OR in-flight-detection prevented a second
    // job — both paths converge on "exactly one job".
    expect(after2).toHaveLength(1);
  });
});
