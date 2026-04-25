/**
 * V2-003-T10 — End-to-end Cults3D ingest
 *
 * Full chain: POST /api/v1/ingest → ingest_jobs row → ingest worker →
 * Cults3D adapter → pipeline → Stash placement → Loot + LootFile.
 *
 * Scenarios (per T10 plan, cults3d slice):
 *   1. Happy path — file staged + placed, ingest_jobs.status='completed'.
 *   2. Auth expired — adapter returns 401 → job failed (auth-revoked).
 *   3. Rate-limit retry — 429 once then 200 → completes.
 *   4. Content removed — 404 → job failed (content-removed).
 *
 * The adapter falls back to `globalThis.fetch` when no override is supplied,
 * so we intercept network calls via msw `setupServer`. The `apps/server` test
 * config sets `onUnhandledRequest: 'error'` to fail loud on accidental real
 * network hits.
 *
 * NOTE on cults3d 404: the adapter's GraphQL endpoint returns 200 with
 * `{data: {creation: null}}` for missing items (see cults3d-adapter unit test
 * #18). We mirror that here for the content-removed case rather than emitting
 * an HTTP 404 (which the adapter would map to network-error).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
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

const DB_PATH = '/tmp/lootgoblin-e2e-cults3d.db';

const server = setupServer();

beforeAll(async () => {
  await setupE2eDb(DB_PATH);
  server.listen({ onUnhandledRequest: 'error' });
  // Adapters cache `globalThis.fetch` at registry-construction time, which is
  // before msw patches the global. Re-register every adapter with a lazy
  // wrapper so requests route through msw.
  rewireAdaptersForMsw();
});
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers local to this file
// ---------------------------------------------------------------------------

const fakeCreationBase = {
  id: 'cults-abc',
  slug: 'cool-vase',
  name: 'Cool Vase',
  description: 'A test vase',
  tags: ['vase'],
  license: { name: 'CC-BY-4.0' },
  creator: { nick: 'maker_alice' },
  illustrations: [{ url: 'https://cults3d.com/img/x.jpg' }],
  downloadableSets: [
    { url: 'https://files.cults3d.com/cool-vase.stl', name: 'cool-vase.stl', size: 24 },
  ],
};

// STL ASCII payload — sniffFormat detects 'stl' from the leading 'solid '.
const STL_BODY = 'solid e2e\nendsolid e2e\n';

function gqlOk(creation: unknown = fakeCreationBase) {
  return HttpResponse.json({ data: { creation } });
}

async function postIngest(body: unknown): Promise<{ status: number; json: any }> {
  const { POST } = await import('../../src/app/api/v1/ingest/route');
  const res = await POST(makeIngestPost(body) as never);
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e — cults3d ingest', () => {
  let userId: string;
  let collectionId: string;

  beforeEach(async () => {
    // Fresh user + collection per test so each ingest is isolated.
    userId = await seedUser();
    const root = await seedStashRoot(userId);
    const col = await seedCollection(userId, root.id);
    collectionId = col.id;
    mockAuthenticate.mockResolvedValue(actor(userId));
  });

  it('happy path — places Loot, LootFile, file on disk, job completed', async () => {
    // Seed valid cults3d credentials (HTTP Basic email + apiKey).
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'real-api-key' },
    });

    server.use(
      // GraphQL — metadata.
      http.post('https://cults3d.com/graphql', () => gqlOk()),
      // File download — the cults3d adapter pulls each downloadableSet URL.
      http.get('https://files.cults3d.com/cool-vase.stl', () =>
        new HttpResponse(STL_BODY, { headers: { 'content-type': 'application/octet-stream' } }),
      ),
    );

    // POST → enqueue.
    const url = 'https://www.cults3d.com/en/3d-model/cool-vase';
    const post = await postIngest({ url, collectionId });
    expect(post.status).toBe(201);
    expect(post.json.sourceId).toBe('cults3d');
    const jobId = post.json.jobId as string;
    expect(typeof jobId).toBe('string');

    // Drive worker until terminal.
    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 10_000 });
    expect(terminal.status).toBe('completed');
    expect(terminal.lootId).toBeTruthy();

    // Loot row exists with correct title + license + creator.
    const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const lootRows = await db
      .select()
      .from(schema.loot)
      .where(eq(schema.loot.id, terminal.lootId!));
    expect(lootRows.length).toBe(1);
    const lootRow = lootRows[0]!;
    expect(lootRow.title).toBe('Cool Vase');
    expect(lootRow.license).toBe('CC-BY-4.0');
    expect(lootRow.creator).toBe('maker_alice');

    // LootFile row.
    const fileRows = await db
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.lootId, terminal.lootId!));
    expect(fileRows.length).toBe(1);
    const fileRow = fileRows[0]!;
    expect(fileRow.size).toBeGreaterThan(0);
    expect(fileRow.format).toBe('stl');

    // Source record persisted (Scavengers attribution).
    const sourceRows = await db
      .select()
      .from(schema.lootSourceRecords)
      .where(eq(schema.lootSourceRecords.lootId, terminal.lootId!));
    expect(sourceRows.length).toBeGreaterThanOrEqual(1);
    expect(sourceRows[0]!.sourceType).toBe('cults3d');
  });

  it('auth expired — adapter sees 401, job paused-auth reason=revoked', async () => {
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'expired-key' },
    });

    server.use(
      http.post('https://cults3d.com/graphql', () => new HttpResponse(null, { status: 401 })),
    );

    const post = await postIngest({
      url: 'https://www.cults3d.com/en/3d-model/some-model',
      collectionId,
    });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId);
    // Pipeline maps adapter `auth-required` (reason='revoked') → job
    // status='paused-auth' so the user can re-authorise without losing the
    // request. The terminal `failed` event the adapter yields after
    // `auth-required` (T7-CF-1 invariant) is observed by the pipeline but
    // does NOT override the paused-auth state.
    expect(terminal.status).toBe('paused-auth');
    expect(terminal.failureReason).toBe('revoked');
    expect(terminal.lootId).toBeFalsy();
  });

  it('rate-limit defer-and-retry — 429 then 200 → completed', async () => {
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'rl-key' },
    });

    let gqlCalls = 0;
    server.use(
      http.post('https://cults3d.com/graphql', () => {
        gqlCalls++;
        if (gqlCalls === 1) {
          return new HttpResponse(null, { status: 429, headers: { 'retry-after': '0' } });
        }
        return gqlOk();
      }),
      http.get('https://files.cults3d.com/cool-vase.stl', () =>
        new HttpResponse(STL_BODY, { headers: { 'content-type': 'application/octet-stream' } }),
      ),
    );

    const post = await postIngest({
      url: 'https://www.cults3d.com/en/3d-model/cool-vase',
      collectionId,
    });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 15_000 });
    expect(terminal.status).toBe('completed');
    expect(gqlCalls).toBeGreaterThanOrEqual(2);
  });

  it('content removed — GraphQL returns creation:null → job failed reason=content-removed', async () => {
    await seedSourceCredential({
      sourceId: 'cults3d',
      kind: 'api-key',
      bag: { email: 'me@example.com', apiKey: 'real-key' },
    });

    server.use(
      http.post('https://cults3d.com/graphql', () => gqlOk(null)),
    );

    const post = await postIngest({
      url: 'https://www.cults3d.com/en/3d-model/gone-model',
      collectionId,
    });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId);
    expect(terminal.status).toBe('failed');
    expect(terminal.failureReason).toBe('content-removed');
    expect(terminal.lootId).toBeFalsy();
  });
});
