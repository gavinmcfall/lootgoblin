/**
 * V2-004-T10 — End-to-end Watchlist HTTP user journey
 *
 * Drives the full chain from the operator's perspective: HTTP route
 * `POST /subscriptions` → `POST /:id/fire-now` → drain workers →
 * `GET /:id/firings`. Plus pause/resume + scheduler interaction.
 *
 * Adapter is mocked at the HTTP layer (msw) so the chain crosses every real
 * boundary: route → DB → scheduler → worker → adapter discovery → ingest
 * worker → adapter fetch → Loot.
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

import {
  setupE2eDb,
  seedUser,
  seedStashRoot,
  seedCollection,
  seedSourceCredential,
  rewireAdaptersForMsw,
  driveSubscriptionChain,
  drainWatchlistJobs,
  drainIngestJobs,
  wipeWatchlistE2eState,
  listIngestJobsForSubscription,
  listWatchlistJobs,
  actor,
} from './_helpers/e2e';
import { runOneSchedulerTick } from '../../src/workers/watchlist-scheduler';

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

const DB_PATH = '/tmp/lootgoblin-t10-watchlist-http.db';
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
// Helpers — minimal cults3d API mock for the HTTP-driven journey.
// ---------------------------------------------------------------------------

function stlBodyFor(slug: string): string {
  return `solid ${slug}\nendsolid ${slug}\n`;
}

function installCults3dMinimal(slugs: string[]): void {
  server.use(
    http.post('https://cults3d.com/graphql', async ({ request }) => {
      const body = (await request.json()) as { query?: string; variables?: Record<string, unknown> };
      const q = body.query ?? '';
      if (q.includes('CreatorListing')) {
        return HttpResponse.json({
          data: {
            creator: {
              creations: {
                edges: slugs.map((s) => ({ cursor: `c-${s}`, node: { id: s, name: s, publishedAt: '2026-01-01T00:00:00Z' } })),
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        });
      }
      if (q.includes('GetCreation')) {
        const slug =
          typeof body.variables?.['slug'] === 'string' ? (body.variables['slug'] as string) : '';
        if (!slugs.includes(slug)) return HttpResponse.json({ data: { creation: null } });
        return HttpResponse.json({
          data: {
            creation: {
              id: slug,
              slug,
              name: slug,
              description: '',
              tags: [],
              license: { name: 'CC0' },
              creator: { nick: 'maker' },
              illustrations: [],
              downloadableSets: [
                { url: `https://files.cults3d.com/${slug}.stl`, name: `${slug}.stl`, size: stlBodyFor(slug).length },
              ],
            },
          },
        });
      }
      return HttpResponse.json({ data: null, errors: [{ message: 'unhandled' }] }, { status: 500 });
    }),
    ...slugs.map((s) =>
      http.get(`https://files.cults3d.com/${s}.stl`, () =>
        new HttpResponse(stlBodyFor(s), { headers: { 'content-type': 'application/octet-stream' } }),
      ),
    ),
  );
}

// Request builders — mirror api-v1-watchlist-subscriptions.test.ts.
function makePost(body: unknown): import('next/server').NextRequest {
  return new Request('http://local/api/v1/watchlist/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}
function makeAction(id: string, action: string, body?: unknown): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions/${id}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as import('next/server').NextRequest;
}
function makeFiringsGet(id: string): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions/${id}/firings`, {
    method: 'GET',
  }) as unknown as import('next/server').NextRequest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e — watchlist HTTP user journey', () => {
  let userId: string;
  let collectionId: string;

  beforeEach(async () => {
    await wipeWatchlistE2eState();
    userId = await seedUser();
    const root = await seedStashRoot(userId);
    const col = await seedCollection(userId, root.id);
    collectionId = col.id;
    mockAuthenticate.mockResolvedValue(actor(userId));

    // Default cults3d creds for HTTP-journey tests.
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'real-key' },
    });
  });

  it('POST subscription → fire-now → drain → GET firings shows completed firing', async () => {
    const slugs = ['h-1', 'h-2'];
    installCults3dMinimal(slugs);

    // 1. POST subscription.
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'maker_h' },
        cadence_seconds: 3600,
        default_collection_id: collectionId,
      }),
    );
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    const subId = createBody.subscription.id as string;

    // 2. POST fire-now.
    const { POST: fireNowPOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/fire-now/route'
    );
    const fireRes = await fireNowPOST(makeAction(subId, 'fire-now'), {
      params: Promise.resolve({ id: subId }),
    });
    expect(fireRes.status).toBe(201);
    const fireBody = await fireRes.json();
    expect(fireBody.job.status).toBe('queued');

    // 3. Drain watchlist + ingest queues.
    await drainWatchlistJobs();
    await drainIngestJobs();

    // 4. Verify ingest jobs all completed.
    const ingest = await listIngestJobsForSubscription(subId);
    expect(ingest.length).toBe(2);
    for (const j of ingest) expect(j.status).toBe('completed');

    // 5. GET firings list.
    const { GET: firingsGET } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/firings/route'
    );
    const firingsRes = await firingsGET(makeFiringsGet(subId), {
      params: Promise.resolve({ id: subId }),
    });
    expect(firingsRes.status).toBe(200);
    const firings = await firingsRes.json();
    expect(firings.firings.length).toBe(1);
    expect(firings.firings[0].status).toBe('completed');
    expect(firings.firings[0].itemsDiscovered).toBe(2);
    expect(firings.firings[0].itemsEnqueued).toBe(2);
  });

  it('pause subscription → scheduler skips it (no new watchlist_job)', async () => {
    // Subscribe + pause via HTTP routes.
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'paused-x' },
        cadence_seconds: 60,
        default_collection_id: collectionId,
      }),
    );
    expect(createRes.status).toBe(201);
    const subId = (await createRes.json()).subscription.id as string;

    const { POST: pausePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/pause/route'
    );
    const pauseRes = await pausePOST(makeAction(subId, 'pause'), {
      params: Promise.resolve({ id: subId }),
    });
    expect(pauseRes.status).toBe(204);

    // Scheduler tick at "well past due" — sub is paused so no enqueue.
    const result = await runOneSchedulerTick({
      now: new Date(Date.now() + 24 * 3600_000),
    });
    expect(result.enqueued).toBe(0);
    expect((await listWatchlistJobs(subId)).length).toBe(0);
  });

  it('resume with catch_up=true → scheduler tick fires immediately', async () => {
    // Subscribe with cadence well in the future (so initial firing won't be due).
    const { POST: subscribePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/route'
    );
    const createRes = await subscribePOST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'resume-x' },
        cadence_seconds: 7200,
        default_collection_id: collectionId,
      }),
    );
    expect(createRes.status).toBe(201);
    const subId = (await createRes.json()).subscription.id as string;

    // Pause → set last_fired_at to a recent value via manual fire then drain
    // (alternative: use route directly with body that sets last_fired_at).
    // Easier: pause + then resume with catch_up=true, which clears
    // last_fired_at, making the sub instantly due.
    const { POST: pausePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/pause/route'
    );
    await pausePOST(makeAction(subId, 'pause'), { params: Promise.resolve({ id: subId }) });

    const { POST: resumePOST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/resume/route'
    );
    const resumeRes = await resumePOST(makeAction(subId, 'resume', { catch_up: true }), {
      params: Promise.resolve({ id: subId }),
    });
    expect(resumeRes.status).toBe(204);

    // Now scheduler tick should fire — last_fired_at is null after catch_up.
    installCults3dMinimal(['r-1']);
    const result = await runOneSchedulerTick();
    expect(result.enqueued).toBe(1);
    expect((await listWatchlistJobs(subId)).length).toBe(1);

    // And the full chain still works through to Loot when we drain.
    await driveSubscriptionChain({ subscriptionId: subId });
    const ingest = await listIngestJobsForSubscription(subId);
    expect(ingest.length).toBe(1);
    expect(ingest[0]!.status).toBe('completed');
  });
});
