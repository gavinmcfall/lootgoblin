/**
 * V2-003b-T1 — End-to-end Thingiverse ingest
 *
 * Reuses the e2e harness from V2-003-T10:
 *   - msw setupServer + rewireAdaptersForMsw() for adapter network injection
 *   - waitForJobTerminal driver (no real worker loop)
 *
 * Scenarios:
 *   1. Happy path with API-token credentials — file streamed + Loot placed.
 *   2. Token refresh during ingest (OAuth) — rotated creds persisted to
 *      source_credentials.
 *   3. File-cap exceeded — adapter caps cut off enumeration; ingest still
 *      completes with a partial NormalizedItem.
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
  makeIngestPost,
  waitForJobTerminal,
} from './_helpers/e2e';
import { getDb, schema } from '../../src/db/client';
import { decrypt } from '../../src/crypto';
import { defaultRegistry, createThingiverseAdapter } from '../../src/scavengers';

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

const DB_PATH = '/tmp/lootgoblin-e2e-thingiverse.db';

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

// 3MF zip-magic header — sniffFormat detects format='3mf' (or zip; either is
// accepted by the default ingest pipeline).
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

const THING_ID = '1234567';
const MODEL_URL = `https://www.thingiverse.com/thing:${THING_ID}`;

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

async function postIngest(body: unknown): Promise<{ status: number; json: any }> {
  const { POST } = await import('../../src/app/api/v1/ingest/route');
  const res = await POST(makeIngestPost(body) as never);
  return { status: res.status, json: await res.json() };
}

const fakeThingMetadata = {
  id: Number(THING_ID),
  name: 'E2E Thing',
  description: 'A test thing',
  license: 'Creative Commons - Attribution',
  is_derivative: false,
  public_url: MODEL_URL,
  added: '2024-01-15T10:30:00Z',
  creator: { name: 'Maker E2E', thingiverse_username: 'maker_e2e' },
  tags: [{ name: 'test' }],
};

describe('e2e — thingiverse ingest', () => {
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

  it('happy path with api-token credentials — file streamed + Loot placed', async () => {
    await seedSourceCredential({
      sourceId: 'thingiverse',
      kind: 'api-key',
      bag: { kind: 'api-token', token: 'static-app-tok' },
    });

    server.use(
      http.get(`https://api.thingiverse.com/things/${THING_ID}`, () =>
        HttpResponse.json(fakeThingMetadata),
      ),
      http.get(`https://api.thingiverse.com/things/${THING_ID}/files`, () =>
        HttpResponse.json([
          {
            id: 100,
            name: 'part1.3mf',
            size: ZIP_MAGIC.length,
            download_url: 'https://cdn.thingiverse.example/file/100',
          },
        ]),
      ),
      http.get('https://cdn.thingiverse.example/file/100', () =>
        new HttpResponse(ZIP_MAGIC, { headers: { 'content-type': 'application/octet-stream' } }),
      ),
    );

    const post = await postIngest({ url: MODEL_URL, collectionId });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 10_000 });
    expect(terminal.status).toBe('completed');
    expect(terminal.lootId).toBeTruthy();

    const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const loot = await db.select().from(schema.loot).where(eq(schema.loot.id, terminal.lootId!));
    expect(loot[0]!.title).toBe('E2E Thing');
    // License preserved verbatim from Thingiverse's string form.
    expect(loot[0]!.license).toBe('Creative Commons - Attribution');
  });

  it('token refresh — near-expiry creds trigger refresh, new bag persisted to source_credentials', async () => {
    const seeded = await seedSourceCredential({
      sourceId: 'thingiverse',
      kind: 'oauth-token',
      bag: buildOAuthBag({ expiresInMs: 5_000 }),
    });

    const dbRead = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const before = await dbRead
      .select()
      .from(schema.sourceCredentials)
      .where(eq(schema.sourceCredentials.id, seeded.id));
    const originalBlob = before[0]!.encryptedBlob as Uint8Array;

    let refreshHits = 0;
    server.use(
      http.post(/thingiverse\.com\/login\/oauth\/access_token/, async () => {
        refreshHits++;
        return HttpResponse.json({
          access_token: 'access-refreshed',
          refresh_token: 'refresh-rotated',
          expires_in: 3600,
        });
      }),
      http.get(`https://api.thingiverse.com/things/${THING_ID}`, () =>
        HttpResponse.json(fakeThingMetadata),
      ),
      http.get(`https://api.thingiverse.com/things/${THING_ID}/files`, () =>
        HttpResponse.json([
          {
            id: 100,
            name: 'part1.3mf',
            size: ZIP_MAGIC.length,
            download_url: 'https://cdn.thingiverse.example/file/100',
          },
        ]),
      ),
      http.get('https://cdn.thingiverse.example/file/100', () =>
        new HttpResponse(ZIP_MAGIC, { headers: { 'content-type': 'application/octet-stream' } }),
      ),
    );

    const post = await postIngest({ url: MODEL_URL, collectionId });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 10_000 });
    expect(terminal.status).toBe('completed');
    expect(refreshHits).toBe(1);

    const after = await dbRead
      .select()
      .from(schema.sourceCredentials)
      .where(eq(schema.sourceCredentials.id, seeded.id));
    const newBlob = after[0]!.encryptedBlob as Uint8Array;
    expect(Buffer.from(newBlob).equals(Buffer.from(originalBlob))).toBe(false);

    const secret = process.env.LOOTGOBLIN_SECRET!;
    const decrypted = JSON.parse(decrypt(Buffer.from(newBlob).toString('utf8'), secret));
    expect(decrypted.accessToken).toBe('access-refreshed');
    expect(decrypted.refreshToken).toBe('refresh-rotated');
  });

  it('cap-exceeded — file-count cap cuts enumeration short, ingest completes with partial Loot', async () => {
    // Use a distinct THING_ID for this test so the pipeline's metadata dedup
    // (keyed by sourceId + sourceItemId) doesn't merge with prior tests.
    const CAP_THING_ID = '7777777';
    const CAP_MODEL_URL = `https://www.thingiverse.com/thing:${CAP_THING_ID}`;

    await seedSourceCredential({
      sourceId: 'thingiverse',
      kind: 'api-key',
      bag: {
        kind: 'api-token',
        token: 'static-app-tok',
        // Caps live as a sibling on the credential bag; adapter resolves to ResolvedCaps.
        caps: { maxFiles: 2 },
      },
    });

    // rewireAdaptersForMsw already registered a lazy-fetch thingiverse adapter.
    void defaultRegistry;
    void createThingiverseAdapter;

    const files = Array.from({ length: 5 }, (_, i) => ({
      id: 700 + i,
      name: `part${i}.3mf`,
      size: ZIP_MAGIC.length + 64,
      download_url: `https://cdn.thingiverse.example/cap/${700 + i}`,
    }));

    server.use(
      http.get(`https://api.thingiverse.com/things/${CAP_THING_ID}`, () =>
        HttpResponse.json({
          ...fakeThingMetadata,
          id: Number(CAP_THING_ID),
          name: 'Cap Test Thing',
          public_url: CAP_MODEL_URL,
        }),
      ),
      http.get(`https://api.thingiverse.com/things/${CAP_THING_ID}/files`, () =>
        HttpResponse.json(files),
      ),
      // Each file gets a unique padded body so content-hash dedup keeps both rows.
      http.get(/^https:\/\/cdn\.thingiverse\.example\/cap\/(\d+)$/, ({ request }) => {
        const m = /\/cap\/(\d+)$/.exec(request.url);
        const id = m ? m[1] : '0';
        const padded = Buffer.concat([ZIP_MAGIC, Buffer.from(`-cap-padding-${id}`.padEnd(64, '0'))]);
        return new HttpResponse(padded, { headers: { 'content-type': 'application/octet-stream' } });
      }),
    );

    const post = await postIngest({ url: CAP_MODEL_URL, collectionId });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 10_000 });
    expect(terminal.status).toBe('completed');
    expect(terminal.lootId).toBeTruthy();

    // Verify only `maxFiles=2` files actually landed via lootFiles.
    const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const lootFiles = await db
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.lootId, terminal.lootId!));
    expect(lootFiles).toHaveLength(2);
  });
});
