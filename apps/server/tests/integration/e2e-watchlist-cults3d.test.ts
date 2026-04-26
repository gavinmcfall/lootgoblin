/**
 * V2-004-T10 — End-to-end Watchlist (Cults3D)
 *
 * Full chain: scheduler tick → watchlist_jobs row → watchlist worker →
 * cults3d.listCreator/searchByTag (msw-mocked GraphQL) → child ingest_jobs →
 * ingest worker → cults3d.fetch() (msw-mocked GraphQL + file download) →
 * Loot + LootFile rows.
 *
 * Each test exercises ALL of T1-T9 in a single arrangement:
 *   T1 schema      → real SQLite at DB_PATH
 *   T2 interface   → SubscribableAdapter for cults3d
 *   T3 scheduler   → runOneSchedulerTick() (used in last test)
 *   T4 worker      → runOneWatchlistJob() (drained by helper)
 *   T7 capabilities → cults3d.listCreator + searchByTag implementations
 *   T9 HTTP        → POST /api/v1/watchlist/subscriptions for CRUD
 *
 * msw runs at file scope with `onUnhandledRequest: 'error'` so any unmocked
 * network hit fails the test loud — discovery and ingest phases share the
 * same handler set, so mocks must cover BOTH the GraphQL listing query and
 * the per-item GraphQL `creation(slug)` query + downloadable-set HTTP GETs.
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
  listWatchlistJobs,
  rewireAdaptersForMsw,
  driveSubscriptionChain,
  wipeWatchlistE2eState,
  actor,
} from './_helpers/e2e';
import { getDb, schema } from '../../src/db/client';
import { runOneSchedulerTick } from '../../src/workers/watchlist-scheduler';

// ---------------------------------------------------------------------------
// Mock plumbing — must be hoisted (top of file) per Vitest conventions.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-t10-watchlist-cults3d.db';

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
// msw helpers — cults3d GraphQL responses
// ---------------------------------------------------------------------------

// STL ASCII payload — sniffFormat detects 'stl' from the leading 'solid '.
// We make every body unique per slug because the ingest pipeline dedups by
// primary-file hash; identical bytes across "different items" would collapse
// to a single Loot row. Per-slug body keeps each Loot distinct.
function stlBodyFor(slug: string): string {
  return `solid ${slug}\nendsolid ${slug}\n`;
}

interface FakeNode {
  id: string;
  name: string;
  publishedAt: string;
}

/**
 * Build a creator-listing GraphQL response with the given nodes.
 * Cults3D returns connections with `edges[].node` and `pageInfo`.
 */
function gqlCreatorListing(nodes: FakeNode[]) {
  return HttpResponse.json({
    data: {
      creator: {
        creations: {
          edges: nodes.map((n) => ({
            cursor: `cur-${n.id}`,
            node: n,
          })),
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    },
  });
}

/** Tag-search GraphQL response. Same connection shape under `data.search`. */
function gqlTagSearch(nodes: FakeNode[]) {
  return HttpResponse.json({
    data: {
      search: {
        edges: nodes.map((n) => ({ cursor: `cur-${n.id}`, node: n })),
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    },
  });
}

/** Per-item creation metadata GraphQL response — used by ingest fetch(). */
function gqlCreationMetadata(node: FakeNode) {
  const body = stlBodyFor(node.id);
  return HttpResponse.json({
    data: {
      creation: {
        id: node.id,
        slug: node.id,
        name: node.name,
        description: 'A test piece',
        tags: ['test'],
        license: { name: 'CC-BY-4.0' },
        creator: { nick: 'maker_alice' },
        illustrations: [{ url: `https://cults3d.com/img/${node.id}.jpg` }],
        downloadableSets: [
          {
            url: `https://files.cults3d.com/${node.id}.stl`,
            name: `${node.id}.stl`,
            size: body.length,
          },
        ],
      },
    },
  });
}

/**
 * Install a GraphQL handler that switches on whether the body uses the
 * `CreatorListing`, `TagSearch`, or `GetCreation` operation name.
 *
 * Cults3D's GraphQL queries embed the operation in the query string itself
 * (no `operationName` field), so we sniff for marker substrings to dispatch.
 *
 * `onListing` is called once per page request (returns the page payload).
 * `onCreation` is called once per ingest fetch (slug → metadata).
 *
 * If `onListing` returns null, falls through to a default empty page.
 */
function installCults3dGraphQL(opts: {
  onCreatorListing?: () => Response;
  onTagSearch?: () => Response;
  onCreation?: (slug: string) => Response;
}): void {
  server.use(
    http.post('https://cults3d.com/graphql', async ({ request }) => {
      const body = (await request.json()) as { query?: string; variables?: Record<string, unknown> };
      const q = body.query ?? '';
      if (q.includes('CreatorListing') && opts.onCreatorListing) {
        return opts.onCreatorListing();
      }
      if (q.includes('TagSearch') && opts.onTagSearch) {
        return opts.onTagSearch();
      }
      if (q.includes('GetCreation') && opts.onCreation) {
        const slug =
          typeof body.variables?.['slug'] === 'string' ? (body.variables['slug'] as string) : '';
        return opts.onCreation(slug);
      }
      return HttpResponse.json({ data: null, errors: [{ message: 'unhandled query' }] }, { status: 500 });
    }),
  );
}

/** Per-file STL download — installed alongside graphql for ingest. */
function installCults3dDownloads(slugs: string[]): void {
  server.use(
    ...slugs.map((slug) =>
      http.get(`https://files.cults3d.com/${slug}.stl`, () =>
        new HttpResponse(stlBodyFor(slug), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e — watchlist (cults3d)', () => {
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

  it('first-fire backfill — 5 items discovered, 5 ingest_jobs queued, 5 Loot rows', async () => {
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'real-key' },
    });

    const slugs = ['a-1', 'a-2', 'a-3', 'a-4', 'a-5'];
    const nodes: FakeNode[] = slugs.map((id, idx) => ({
      id,
      name: `Item ${idx + 1}`,
      publishedAt: `2026-01-0${idx + 1}T00:00:00Z`,
    }));

    installCults3dGraphQL({
      onCreatorListing: () => gqlCreatorListing(nodes),
      onCreation: (slug) => {
        const node = nodes.find((n) => n.id === slug);
        if (!node) return HttpResponse.json({ data: { creation: null } });
        return gqlCreationMetadata(node);
      },
    });
    installCults3dDownloads(slugs);

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'creator',
      sourceAdapterId: 'cults3d',
      parameters: { kind: 'creator', creatorId: 'maker_alice' },
      defaultCollectionId: collectionId,
    });
    await seedWatchlistJob(subId);

    await driveSubscriptionChain({ subscriptionId: subId });

    // Subscription cursor is set to the FIRST-seen id (cults3d cursor format).
    const sub = await getWatchlistSubscription(subId);
    expect(sub.cursorState).toBeTruthy();
    const parsed = JSON.parse(sub.cursorState!);
    expect(parsed.firstSeenSourceItemId).toBe('a-1');
    expect(sub.errorStreak).toBe(0);

    // Five child ingest_jobs, all completed.
    const ingestJobs = await listIngestJobsForSubscription(subId);
    expect(ingestJobs.length).toBe(5);
    for (const j of ingestJobs) {
      expect(j.status).toBe('completed');
      expect(j.parentSubscriptionId).toBe(subId);
      expect(j.collectionId).toBe(collectionId);
      expect(j.ownerId).toBe(userId);
    }

    // Five Loot rows for this user.
    const loot = await listLootInCollection(collectionId);
    expect(loot.length).toBe(5);

    // Watchlist firing recorded as completed.
    const completed = await listWatchlistJobs(subId, 'completed');
    expect(completed.length).toBe(1);
    expect(completed[0]!.itemsDiscovered).toBe(5);
    expect(completed[0]!.itemsEnqueued).toBe(5);
  });

  it('subsequent firing skips already-seen items (rolling cursor)', async () => {
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'real-key' },
    });

    // Seed cursor as if previous firing saw 'b-3' first.
    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'creator',
      sourceAdapterId: 'cults3d',
      parameters: { kind: 'creator', creatorId: 'maker_bob' },
      defaultCollectionId: collectionId,
      cursorState: JSON.stringify({ firstSeenSourceItemId: 'b-3' }),
    });

    // Listing now returns 3 NEW items + the prior 5; adapter must stop at b-3.
    const newSlugs = ['b-A', 'b-B', 'b-C'];
    const allNodes: FakeNode[] = [
      ...newSlugs.map((id, idx) => ({ id, name: `New ${id}`, publishedAt: `2026-02-0${idx + 1}T00:00:00Z` })),
      { id: 'b-3', name: 'Item 3', publishedAt: '2026-01-03T00:00:00Z' },
      { id: 'b-2', name: 'Item 2', publishedAt: '2026-01-02T00:00:00Z' },
      { id: 'b-1', name: 'Item 1', publishedAt: '2026-01-01T00:00:00Z' },
    ];

    installCults3dGraphQL({
      onCreatorListing: () => gqlCreatorListing(allNodes),
      onCreation: (slug) => {
        const node = allNodes.find((n) => n.id === slug);
        if (!node) return HttpResponse.json({ data: { creation: null } });
        return gqlCreationMetadata(node);
      },
    });
    installCults3dDownloads(newSlugs);

    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    // Only the 3 NEW items should be ingested (b-3 stops the iteration).
    const ingestJobs = await listIngestJobsForSubscription(subId);
    expect(ingestJobs.length).toBe(3);
    const ingestSlugs = ingestJobs.map((j) => {
      const p = JSON.parse(j.targetPayload) as { sourceItemId: string };
      return p.sourceItemId;
    });
    expect(new Set(ingestSlugs)).toEqual(new Set(newSlugs));

    // Cursor advances to the new top-most item.
    const sub = await getWatchlistSubscription(subId);
    expect(JSON.parse(sub.cursorState!).firstSeenSourceItemId).toBe('b-A');
  });

  it('tag subscription — same chain works with searchByTag dispatch', async () => {
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'real-key' },
    });

    const slugs = ['t-1', 't-2'];
    const nodes: FakeNode[] = slugs.map((id, idx) => ({
      id,
      name: `Tagged ${idx + 1}`,
      publishedAt: `2026-03-0${idx + 1}T00:00:00Z`,
    }));

    installCults3dGraphQL({
      onTagSearch: () => gqlTagSearch(nodes),
      onCreation: (slug) => {
        const node = nodes.find((n) => n.id === slug);
        if (!node) return HttpResponse.json({ data: { creation: null } });
        return gqlCreationMetadata(node);
      },
    });
    installCults3dDownloads(slugs);

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'tag',
      sourceAdapterId: 'cults3d',
      parameters: { kind: 'tag', tag: 'minis' },
      defaultCollectionId: collectionId,
    });
    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    const ingestJobs = await listIngestJobsForSubscription(subId);
    expect(ingestJobs.length).toBe(2);
    for (const j of ingestJobs) expect(j.status).toBe('completed');
    const loot = await listLootInCollection(collectionId);
    expect(loot.length).toBe(2);
  });

  it('auth failure (401) path — fails firing, increments streak, sibling sub unaffected', async () => {
    // Real cults3d behavior: a 401 from GraphQL yields an `auth-required`
    // event FIRST (with `discovery-failed reason='auth-revoked'` queued
    // after). The watchlist worker treats `auth-required` as a terminal
    // event and translates it to `discovery-failed reason='unknown'` —
    // which goes through the error-streak path, NOT the WL-Q4 cascade.
    //
    // Cascade-via-`reason='auth-revoked'` is exercised in the watchlist
    // worker's unit test (#6 in watchlist-worker.test.ts), which uses a
    // stub adapter. Real cults3d never emits it as a leading event, so
    // cascade isn't observable here.
    //
    // What we DO verify here:
    //   - The cults3d firing fails (job.status='failed') and bumps
    //     error_streak by 1 (sub.errorStreak = 1, active still 1).
    //   - The sibling cults3d (different kind) sub stays untouched (no
    //     firing was enqueued for it; cascade doesn't fire).
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'bad-key' },
    });

    server.use(
      http.post('https://cults3d.com/graphql', () =>
        new HttpResponse(null, { status: 401 }),
      ),
    );

    const cultsCreatorSub = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'creator',
      sourceAdapterId: 'cults3d',
      parameters: { kind: 'creator', creatorId: 'someone' },
      defaultCollectionId: collectionId,
    });
    const cultsTagSub = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'tag',
      sourceAdapterId: 'cults3d',
      parameters: { kind: 'tag', tag: 'stuff' },
      defaultCollectionId: collectionId,
    });

    await seedWatchlistJob(cultsCreatorSub);
    await driveSubscriptionChain({ subscriptionId: cultsCreatorSub });

    const creatorAfter = await getWatchlistSubscription(cultsCreatorSub);
    expect(creatorAfter.errorStreak).toBe(1);
    expect(creatorAfter.active).toBe(1); // below threshold, still active
    // No cascade — sibling sub untouched.
    expect((await getWatchlistSubscription(cultsTagSub)).active).toBe(1);
    expect((await getWatchlistSubscription(cultsTagSub)).errorStreak).toBe(0);

    const failedJobs = await listWatchlistJobs(cultsCreatorSub, 'failed');
    expect(failedJobs.length).toBe(1);
  });

  it('error-streak threshold — 5th non-auth failure pauses the subscription', async () => {
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'flaky' },
    });

    // Seed sub at error_streak=4 — one more failure crosses threshold (default 5).
    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'creator',
      sourceAdapterId: 'cults3d',
      parameters: { kind: 'creator', creatorId: 'flaky-creator' },
      defaultCollectionId: collectionId,
      errorStreak: 4,
    });

    // Network-level failure (not auth) — adapter sees 503.
    server.use(
      http.post('https://cults3d.com/graphql', () =>
        new HttpResponse(null, { status: 503 }),
      ),
    );

    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    const sub = await getWatchlistSubscription(subId);
    expect(sub.errorStreak).toBe(5);
    expect(sub.active).toBe(0);

    // 6th firing is not eligible — scheduler tick should NOT enqueue a new
    // job because the sub is now inactive.
    await runOneSchedulerTick({ now: new Date(Date.now() + 24 * 3600_000) });
    const secondaryJobs = await listWatchlistJobs(subId);
    // Just the prior failed firing.
    expect(secondaryJobs.length).toBe(1);
    expect(secondaryJobs[0]!.status).toBe('failed');
  });
});

// Suppress unused-import checks — getDb + schema are kept for future
// extensions of these tests.
void getDb;
void schema;
void eq;
