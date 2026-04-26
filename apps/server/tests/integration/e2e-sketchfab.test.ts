/**
 * V2-003-T10 — End-to-end Sketchfab ingest
 *
 * Adds OAuth refresh + token-rotation persistence on top of the cults3d
 * full-chain pattern.
 *
 * Scenarios:
 *   1. Happy path with OAuth credentials — file streamed + placed.
 *   2. Token refresh during ingest — expiring credentials trigger refresh
 *      before metadata call; pipeline `onTokenRefreshed` callback rewrites
 *      source_credentials with the new bag (verify the encrypted blob in
 *      the DB changed).
 *   3. Refresh failure — token endpoint returns 400 → job paused-auth
 *      reason='revoked'.
 *   4. No-downloadable-formats — download endpoint returns {} → job failed
 *      reason='no-downloadable-formats'.
 *
 * Sketchfab UID extraction: model URLs are `/3d-models/<slug>-<uid>` where
 * <uid> is 12-64 alphanumeric chars. We use `cool-model-abc123def456` so the
 * adapter extracts uid='abc123def456'.
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

const DB_PATH = '/tmp/lootgoblin-e2e-sketchfab.db';

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

// GLB magic prefix — sniffFormat detects format='glb'.
const GLB_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00]);

const UID = 'abc123def4567'; // 13 chars hex-ish, passes the 12-64 alphanum guard
const MODEL_URL = `https://sketchfab.com/3d-models/cool-model-${UID}`;

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

describe('e2e — sketchfab ingest', () => {
  let userId: string;
  let collectionId: string;

  beforeEach(async () => {
    // Wipe credentials between tests — they're keyed by sourceId (not by
    // user), so a refresh test that rotates tokens would otherwise leak the
    // rotated bag into the next test's lookup.
    const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    await db.delete(schema.sourceCredentials);

    userId = await seedUser();
    const root = await seedStashRoot(userId);
    const col = await seedCollection(userId, root.id);
    collectionId = col.id;
    mockAuthenticate.mockResolvedValue(actor(userId));
  });

  it('happy path with OAuth credentials — places Loot, license preserved verbatim', async () => {
    await seedSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      // Long-lived: more than the 60s refresh-lead window.
      bag: buildOAuthBag({ expiresInMs: 60 * 60_000 }),
    });

    server.use(
      http.get(`https://api.sketchfab.com/v3/models/${UID}`, () =>
        HttpResponse.json({
          uid: UID,
          name: 'Cool Model',
          description: 'A test model',
          license: { slug: 'cc-by-sa-4.0', label: 'CC-BY-SA 4.0' },
          user: { username: 'maker_bob', displayName: 'Maker Bob' },
          tags: [{ name: 'sci-fi', slug: 'sci-fi' }],
          downloadable: true,
        }),
      ),
      http.get(`https://api.sketchfab.com/v3/models/${UID}/download`, () =>
        HttpResponse.json({
          glb: { url: 'https://cdn.sketchfab.example/file.glb', expires: 9999999999, size: GLB_MAGIC.length },
        }),
      ),
      http.get('https://cdn.sketchfab.example/file.glb', () =>
        new HttpResponse(GLB_MAGIC, {
          headers: { 'content-type': 'model/gltf-binary' },
        }),
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
    expect(loot[0]!.title).toBe('Cool Model');
    // License preserved verbatim from `metadata.license.slug` (per adapter).
    expect(loot[0]!.license).toBe('cc-by-sa-4.0');
  });

  it('token refresh — near-expiry creds trigger refresh, new bag persisted to source_credentials', async () => {
    // Seed credentials whose expiresAt is well inside the 60s refresh-lead.
    const seeded = await seedSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      bag: buildOAuthBag({ expiresInMs: 5_000 }),
    });

    // Capture the original blob so we can verify it was rewritten.
    const dbRead = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const before = await dbRead.select().from(schema.sourceCredentials).where(eq(schema.sourceCredentials.id, seeded.id));
    const originalBlob = (before[0]!.encryptedBlob as Uint8Array);

    let refreshHits = 0;
    server.use(
      http.post(/sketchfab\.com\/oauth2\/token/,async () => {
        refreshHits++;
        return HttpResponse.json({
          access_token: 'access-refreshed',
          refresh_token: 'refresh-rotated',
          expires_in: 3600,
        });
      }),
      http.get(`https://api.sketchfab.com/v3/models/${UID}`, () =>
        HttpResponse.json({
          uid: UID,
          name: 'Refresh Model',
          description: '',
          license: { slug: 'cc0' },
          user: { username: 'maker' },
          tags: [],
          downloadable: true,
        }),
      ),
      http.get(`https://api.sketchfab.com/v3/models/${UID}/download`, () =>
        HttpResponse.json({
          glb: { url: 'https://cdn.sketchfab.example/refresh.glb', expires: 9999999999, size: GLB_MAGIC.length },
        }),
      ),
      http.get('https://cdn.sketchfab.example/refresh.glb', () =>
        new HttpResponse(GLB_MAGIC, { headers: { 'content-type': 'model/gltf-binary' } }),
      ),
    );

    const post = await postIngest({ url: MODEL_URL, collectionId });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 10_000 });
    expect(terminal.status).toBe('completed');
    expect(refreshHits).toBe(1);

    // Source credential blob has been rewritten with the new tokens.
    const after = await dbRead.select().from(schema.sourceCredentials).where(eq(schema.sourceCredentials.id, seeded.id));
    const newBlob = (after[0]!.encryptedBlob as Uint8Array);
    expect(Buffer.from(newBlob).equals(Buffer.from(originalBlob))).toBe(false);

    // Decrypt + verify the access/refresh tokens were rotated.
    const secret = process.env.LOOTGOBLIN_SECRET!;
    const decrypted = JSON.parse(decrypt(Buffer.from(newBlob).toString('utf8'), secret));
    expect(decrypted.accessToken).toBe('access-refreshed');
    expect(decrypted.refreshToken).toBe('refresh-rotated');
  });

  it('refresh failure — token endpoint returns 400 → job paused-auth reason=revoked', async () => {
    await seedSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      bag: buildOAuthBag({ expiresInMs: 5_000 }),
    });

    server.use(
      http.post(/sketchfab\.com\/oauth2\/token/,() =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
      ),
    );

    const post = await postIngest({ url: MODEL_URL, collectionId });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId);
    expect(terminal.status).toBe('paused-auth');
    expect(terminal.failureReason).toBe('revoked');
  });

  it('no-downloadable-formats — download endpoint returns {} → job failed', async () => {
    await seedSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      bag: buildOAuthBag({ expiresInMs: 60 * 60_000 }),
    });

    server.use(
      http.get(`https://api.sketchfab.com/v3/models/${UID}`, () =>
        HttpResponse.json({
          uid: UID,
          name: 'No Formats',
          description: '',
          license: { slug: 'cc0' },
          user: { username: 'm' },
          tags: [],
          downloadable: true,
        }),
      ),
      http.get(`https://api.sketchfab.com/v3/models/${UID}/download`, () =>
        HttpResponse.json({}),
      ),
    );

    const post = await postIngest({ url: MODEL_URL, collectionId });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId);
    expect(terminal.status).toBe('failed');
    expect(terminal.failureReason).toBe('no-downloadable-formats');
  });
});
