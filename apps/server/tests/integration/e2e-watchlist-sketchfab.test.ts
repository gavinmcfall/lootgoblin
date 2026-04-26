/**
 * V2-004-T10 — End-to-end Watchlist (Sketchfab)
 *
 * Adds OAuth refresh + saved_search dispatch to the cults3d pattern. Like
 * the cults3d e2e, every test fires the full chain (T1-T9) end-to-end:
 * sketchfab.listCreator/searchByTag/search → child ingest_jobs → sketchfab
 * .fetch() (metadata + download endpoints) → Loot rows.
 *
 * Sketchfab UID: model URLs are `/3d-models/<slug>-<uid>` where <uid> is
 * 12-64 alphanumeric chars. `cool-model-abc123def4567` extracts uid='abc123def4567'.
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
  seedWatchlistSubscription,
  seedWatchlistJob,
  getWatchlistSubscription,
  listIngestJobsForSubscription,
  listLootInCollection,
  rewireAdaptersForMsw,
  driveSubscriptionChain,
  wipeWatchlistE2eState,
  actor,
} from './_helpers/e2e';
import { getDb, schema } from '../../src/db/client';
import { decrypt } from '../../src/crypto';

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

const DB_PATH = '/tmp/lootgoblin-t10-watchlist-sketchfab.db';
const server = setupServer();

beforeAll(async () => {
  await setupE2eDb(DB_PATH);
  server.listen({ onUnhandledRequest: 'error' });
  rewireAdaptersForMsw();
});
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers — sketchfab API mocks
// ---------------------------------------------------------------------------

// GLB magic prefix — sniffFormat detects format='glb'. We append a per-uid
// suffix so each item's bytes hash uniquely (avoiding pipeline dedup).
const GLB_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00]);
function glbBodyFor(uid: string): Buffer {
  return Buffer.concat([GLB_MAGIC, Buffer.from(uid, 'utf8')]);
}

interface SfModel {
  uid: string;
  name: string;
  publishedAt: string;
}

function buildOAuthBag(opts: { expiresInMs: number }): Record<string, unknown> {
  return {
    kind: 'oauth',
    accessToken: 'access-original',
    refreshToken: 'refresh-original',
    expiresAt: Date.now() + opts.expiresInMs,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
  };
}

/**
 * Install handlers covering both the discovery listing endpoint and the
 * per-model metadata + download chain.
 *
 * `listingPath` is the path the discovery endpoint hits (e.g.
 * `/v3/users/<id>/models` or `/v3/search`).
 */
function installSketchfabApi(opts: {
  listingPath: string;
  results: SfModel[];
  pagedResults?: SfModel[]; // when set, listingPath returns a `next` link to a 2nd page
}): void {
  const handlers = [];

  // Listing — pagination support: when pagedResults is supplied, the first
  // page returns `next` pointing to /v3/__page2__ which returns pagedResults.
  if (opts.pagedResults && opts.pagedResults.length > 0) {
    handlers.push(
      http.get(`https://api.sketchfab.com${opts.listingPath}`, () =>
        HttpResponse.json({
          results: opts.results,
          next: 'https://api.sketchfab.com/v3/__page2__',
        }),
      ),
      http.get('https://api.sketchfab.com/v3/__page2__', () =>
        HttpResponse.json({ results: opts.pagedResults!, next: null }),
      ),
    );
  } else {
    handlers.push(
      http.get(`https://api.sketchfab.com${opts.listingPath}`, () =>
        HttpResponse.json({ results: opts.results, next: null }),
      ),
    );
  }

  // Metadata + download endpoints for each model.
  for (const m of opts.results.concat(opts.pagedResults ?? [])) {
    handlers.push(
      http.get(`https://api.sketchfab.com/v3/models/${m.uid}`, () =>
        HttpResponse.json({
          uid: m.uid,
          name: m.name,
          description: '',
          license: { slug: 'cc-by-4.0', label: 'CC-BY 4.0' },
          user: { username: 'maker_x', displayName: 'Maker X' },
          tags: [],
          downloadable: true,
          publishedAt: m.publishedAt,
        }),
      ),
      http.get(`https://api.sketchfab.com/v3/models/${m.uid}/download`, () =>
        HttpResponse.json({
          glb: {
            url: `https://cdn.sketchfab.example/${m.uid}.glb`,
            expires: 9999999999,
            size: glbBodyFor(m.uid).length,
          },
        }),
      ),
      http.get(`https://cdn.sketchfab.example/${m.uid}.glb`, () =>
        new HttpResponse(glbBodyFor(m.uid), {
          headers: { 'content-type': 'model/gltf-binary' },
        }),
      ),
    );
  }

  server.use(...handlers);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e — watchlist (sketchfab)', () => {
  let userId: string;
  let collectionId: string;

  beforeEach(async () => {
    await wipeWatchlistE2eState();
    userId = await seedUser();
    const root = await seedStashRoot(userId);
    const col = await seedCollection(userId, root.id);
    collectionId = col.id;
    mockAuthenticate.mockResolvedValue(actor(userId));
  });

  it('happy path with OAuth credentials — listCreator → 3 ingest jobs → 3 Loot rows', async () => {
    await seedSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      bag: buildOAuthBag({ expiresInMs: 60 * 60_000 }),
    });

    const creator = 'maker_x';
    const models: SfModel[] = [
      { uid: 'aaa1aaa1aaa1', name: 'M1', publishedAt: '2026-01-01T00:00:00Z' },
      { uid: 'bbb2bbb2bbb2', name: 'M2', publishedAt: '2026-01-02T00:00:00Z' },
      { uid: 'ccc3ccc3ccc3', name: 'M3', publishedAt: '2026-01-03T00:00:00Z' },
    ];

    installSketchfabApi({
      listingPath: `/v3/users/${creator}/models`,
      results: models,
    });

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'creator',
      sourceAdapterId: 'sketchfab',
      parameters: { kind: 'creator', creatorId: creator },
      defaultCollectionId: collectionId,
    });
    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    const ingestJobs = await listIngestJobsForSubscription(subId);
    expect(ingestJobs.length).toBe(3);
    for (const j of ingestJobs) expect(j.status).toBe('completed');

    const loot = await listLootInCollection(collectionId);
    expect(loot.length).toBe(3);
    for (const l of loot) {
      expect(l.license).toBe('cc-by-4.0');
    }
  });

  it('token refresh during discovery — onTokenRefreshed persists rotated bag', async () => {
    const seeded = await seedSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      bag: buildOAuthBag({ expiresInMs: 5_000 }), // inside 60s refresh window
    });

    let refreshHits = 0;
    server.use(
      http.post(/sketchfab\.com\/oauth2\/token/, async () => {
        refreshHits++;
        return HttpResponse.json({
          access_token: 'access-refreshed',
          refresh_token: 'refresh-rotated',
          expires_in: 3600,
        });
      }),
    );

    const models: SfModel[] = [
      { uid: 'rrrr1rrrr1rr', name: 'R1', publishedAt: '2026-01-01T00:00:00Z' },
    ];
    installSketchfabApi({ listingPath: '/v3/users/refresher/models', results: models });

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'creator',
      sourceAdapterId: 'sketchfab',
      parameters: { kind: 'creator', creatorId: 'refresher' },
      defaultCollectionId: collectionId,
    });
    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    expect(refreshHits).toBe(1);

    // Verify the credential blob has been rewritten with the new tokens.
    const dbc = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const after = await dbc
      .select({ encryptedBlob: schema.sourceCredentials.encryptedBlob })
      .from(schema.sourceCredentials)
      .where(eq(schema.sourceCredentials.id, seeded.id));
    const newBlob = Buffer.from(after[0]!.encryptedBlob as Uint8Array);
    const decrypted = JSON.parse(decrypt(newBlob.toString('utf8'), process.env.LOOTGOBLIN_SECRET!));
    expect(decrypted.accessToken).toBe('access-refreshed');
    expect(decrypted.refreshToken).toBe('refresh-rotated');
    // Long-lived OAuth metadata preserved (merge semantics from worker T4-L12).
    expect(decrypted.clientId).toBe('test-client-id');
    expect(decrypted.clientSecret).toBe('test-client-secret');

    // And the chain still landed Loot.
    expect((await listLootInCollection(collectionId)).length).toBe(1);
  });

  it('saved_search subscription — search dispatch path lands Loot', async () => {
    await seedSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      bag: buildOAuthBag({ expiresInMs: 60 * 60_000 }),
    });

    // Discovery hits /v3/search?type=models&q=dragon — no per-query path,
    // we install a generic /v3/search handler.
    const models: SfModel[] = [
      { uid: 'sss1sss1sss1', name: 'Dragon 1', publishedAt: '2026-01-01T00:00:00Z' },
      { uid: 'sss2sss2sss2', name: 'Dragon 2', publishedAt: '2026-01-02T00:00:00Z' },
    ];
    installSketchfabApi({ listingPath: '/v3/search', results: models });

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'saved_search',
      sourceAdapterId: 'sketchfab',
      parameters: { kind: 'saved_search', query: 'dragon' },
      defaultCollectionId: collectionId,
    });
    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    expect((await listIngestJobsForSubscription(subId)).length).toBe(2);
    expect((await listLootInCollection(collectionId)).length).toBe(2);
  });

  it('pagination across discovery — 2 pages of results all ingested (capped at first-fire backfill)', async () => {
    await seedSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      bag: buildOAuthBag({ expiresInMs: 60 * 60_000 }),
    });

    // Default WATCHLIST_FIRST_FIRE_BACKFILL is 20. We supply 15 + 15 = 30
    // models across 2 pages; on first-fire the adapter caps at 20, so
    // assert exactly 20 ingest jobs.
    const page1: SfModel[] = Array.from({ length: 15 }, (_, i) => ({
      uid: `pg1${String(i).padStart(9, '0')}`,
      name: `P1-${i}`,
      publishedAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const page2: SfModel[] = Array.from({ length: 15 }, (_, i) => ({
      uid: `pg2${String(i).padStart(9, '0')}`,
      name: `P2-${i}`,
      publishedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));

    installSketchfabApi({
      listingPath: '/v3/users/paginator/models',
      results: page1,
      pagedResults: page2,
    });

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'creator',
      sourceAdapterId: 'sketchfab',
      parameters: { kind: 'creator', creatorId: 'paginator' },
      defaultCollectionId: collectionId,
    });
    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId, maxIterations: 100 });

    const ingestJobs = await listIngestJobsForSubscription(subId);
    expect(ingestJobs.length).toBe(20);
    // Cursor advances to the FIRST item across both pages (top-most listing).
    const sub = await getWatchlistSubscription(subId);
    const cur = JSON.parse(sub.cursorState!);
    expect(cur.firstSeenSourceItemId).toBe(page1[0]!.uid);
  });
});
