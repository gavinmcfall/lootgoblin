/**
 * V2-003-T10 — Full-chain verification
 *
 * Pins two spec invariants in code:
 *
 *   1. Sub-60s completion — `planning/odad/plans/v2-003-scavengers-ingest.md`
 *      line 124 commits to a 60s end-to-end ceiling on a seeded environment.
 *      The test wraps a happy-path cults3d ingest in a `Date.now()` spread
 *      assertion that fails if it ever creeps over 60_000 ms.
 *
 *   2. Idempotency-Key end-to-end — POSTing twice with the same key produces
 *      exactly one Loot row + one on-disk file. The HTTP-layer idempotency is
 *      already covered by api-v1-ingest tests, but this version also drives
 *      the worker so the assertion is "at the end of the second POST, the
 *      DB still shows ONE Loot, not two."
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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
  actor,
  uid,
  makeIngestPost,
  waitForJobTerminal,
} from './_helpers/e2e';
import { getDb, schema } from '../../src/db/client';

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

const DB_PATH = '/tmp/lootgoblin-e2e-fullchain.db';
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

const STL_BODY = 'solid full-chain\nendsolid full-chain\n';

const fakeCreation = {
  id: 'fc-id',
  slug: 'full-chain-vase',
  name: 'Full Chain Vase',
  description: '',
  tags: [],
  license: { name: 'CC-BY-4.0' },
  creator: { nick: 'tester' },
  illustrations: [],
  downloadableSets: [
    { url: 'https://files.cults3d.com/full-chain.stl', name: 'full-chain.stl', size: STL_BODY.length },
  ],
};

async function postIngest(body: unknown, idempotencyKey?: string): Promise<{ status: number; json: any }> {
  const { POST } = await import('../../src/app/api/v1/ingest/route');
  const res = await POST(makeIngestPost(body, idempotencyKey) as never);
  return { status: res.status, json: await res.json() };
}

describe('e2e — full-chain spec invariants', () => {
  let userId: string;
  let collectionId: string;

  beforeEach(async () => {
    const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    await db.delete(schema.sourceCredentials);

    userId = await seedUser();
    const root = await seedStashRoot(userId);
    const col = await seedCollection(userId, root.id);
    collectionId = col.id;
    mockAuthenticate.mockResolvedValue(actor(userId));
  });

  it('sub-60s completion — happy-path cults3d POST → terminal completed under 60_000 ms', async () => {
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'real-key' },
    });

    server.use(
      http.post('https://cults3d.com/graphql', () =>
        HttpResponse.json({ data: { creation: fakeCreation } }),
      ),
      http.get('https://files.cults3d.com/full-chain.stl', () =>
        new HttpResponse(STL_BODY, { headers: { 'content-type': 'application/octet-stream' } }),
      ),
    );

    const startedAt = Date.now();
    const post = await postIngest({
      url: 'https://www.cults3d.com/en/3d-model/full-chain-vase',
      collectionId,
    });
    expect(post.status).toBe(201);
    const terminal = await waitForJobTerminal(post.json.jobId, { timeoutMs: 60_000 });
    const elapsed = Date.now() - startedAt;

    expect(terminal.status).toBe('completed');
    // The spec headline: < 60s end-to-end on a seeded environment.
    expect(elapsed).toBeLessThan(60_000);
  });

  it('idempotency end-to-end — POST twice with same key → exactly one Loot row + one file', async () => {
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'real-key' },
    });

    server.use(
      http.post('https://cults3d.com/graphql', () =>
        HttpResponse.json({ data: { creation: fakeCreation } }),
      ),
      http.get('https://files.cults3d.com/full-chain.stl', () =>
        new HttpResponse(STL_BODY, { headers: { 'content-type': 'application/octet-stream' } }),
      ),
    );

    const idemKey = `idem-e2e-${uid()}`;
    const body = {
      url: 'https://www.cults3d.com/en/3d-model/full-chain-vase',
      collectionId,
    };

    // First POST creates the job; drive worker to completion.
    const first = await postIngest(body, idemKey);
    expect(first.status).toBe(201);
    const jobId = first.json.jobId as string;
    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 30_000 });
    expect(terminal.status).toBe('completed');
    const lootId = terminal.lootId!;

    // Second POST with same key → 200 + same jobId, no new row.
    const second = await postIngest(body, idemKey);
    expect(second.status).toBe(200);
    expect(second.json.jobId).toBe(jobId);

    const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const idemRows = await db
      .select()
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.idempotencyKey, idemKey));
    expect(idemRows.length).toBe(1);
    expect(idemRows[0]!.id).toBe(jobId);

    // Exactly one Loot row + one LootFile from this idempotent pair.
    const lootRows = await db
      .select()
      .from(schema.loot)
      .where(eq(schema.loot.id, lootId));
    expect(lootRows.length).toBe(1);

    const fileRows = await db
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.lootId, lootId));
    expect(fileRows.length).toBe(1);
  });
});
