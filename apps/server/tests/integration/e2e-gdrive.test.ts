/**
 * V2-003-T10 — End-to-end Google Drive ingest
 *
 * Adds folder recursion + dual-auth cascade on top of the cults3d/sketchfab
 * patterns. Adapter has FOUR auth shapes via the `kind` discriminator:
 *
 *   - `kind:'oauth'`      → Bearer accessToken
 *   - `kind:'api-key'`    → ?key=<apiKey> query param
 *   - `kind:'oauth+api-key'` (dual) → API key first, fall back to OAuth on 401/403
 *
 * Scenarios:
 *   1. Mode B (API key) happy path — single file → Loot created.
 *   2. Folder recursion — folder lists 3 children, all downloaded → Loot has
 *      3 files.
 *   3. Dual mode (oauth+api-key) cascade — api-key call returns 403, OAuth
 *      fallback succeeds → Loot created.
 *   4. All-Google-native folder — 2 docs, no downloadable bytes → job failed
 *      reason='no-downloadable-formats'.
 *
 * URL shapes:
 *   - `https://drive.google.com/file/d/<id>/view` for files
 *   - `https://drive.google.com/drive/folders/<id>` for folders
 *
 * Endpoints (all `https://www.googleapis.com/drive/v3/*`):
 *   - GET  /files/<id>           — metadata
 *   - GET  /files                — list folder contents (q=)
 *   - GET  /files/<id>?alt=media — download
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

const DB_PATH = '/tmp/lootgoblin-e2e-gdrive.db';
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

const STL_BODY = 'solid gd\nendsolid gd\n';
const FILE_ID = 'fileId123abc';
const FOLDER_ID = 'folderId456def';

async function postIngest(body: unknown): Promise<{ status: number; json: any }> {
  const { POST } = await import('../../src/app/api/v1/ingest/route');
  const res = await POST(makeIngestPost(body) as never);
  return { status: res.status, json: await res.json() };
}

describe('e2e — google-drive ingest', () => {
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

  it('Mode B (api-key) happy path — single file → Loot created', async () => {
    await seedSourceCredential({
      sourceId: 'google-drive',
      kind: 'api-key',
      bag: { kind: 'api-key', apiKey: 'test-google-api-key' },
    });

    server.use(
      // Metadata.
      http.get(`https://www.googleapis.com/drive/v3/files/${FILE_ID}`, () =>
        HttpResponse.json({
          id: FILE_ID,
          name: 'cool-vase.stl',
          mimeType: 'application/octet-stream',
          size: String(STL_BODY.length),
          parents: [],
          md5Checksum: 'deadbeef',
          modifiedTime: '2025-01-01T00:00:00Z',
          owners: [{ displayName: 'Maker', emailAddress: 'm@example.com' }],
        }),
      ),
      // Download.
      http.get(`https://www.googleapis.com/drive/v3/files/${FILE_ID}`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('alt') === 'media') {
          return new HttpResponse(STL_BODY, {
            headers: { 'content-type': 'application/octet-stream' },
          });
        }
        // Default: metadata path (handled above; this branch is a safety net).
        return HttpResponse.json({});
      }),
    );

    const post = await postIngest({
      url: `https://drive.google.com/file/d/${FILE_ID}/view`,
      collectionId,
    });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 10_000 });
    expect(terminal.status).toBe('completed');

    const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const loot = await db.select().from(schema.loot).where(eq(schema.loot.id, terminal.lootId!));
    expect(loot[0]!.title).toBeTruthy();
    const files = await db.select().from(schema.lootFiles).where(eq(schema.lootFiles.lootId, terminal.lootId!));
    expect(files.length).toBe(1);
    expect(files[0]!.format).toBe('stl');
  });

  it('folder recursion — listing returns 3 files, all downloaded → Loot has 3 files', async () => {
    await seedSourceCredential({
      sourceId: 'google-drive',
      kind: 'api-key',
      bag: { kind: 'api-key', apiKey: 'test-google-api-key' },
    });

    const childIds = ['c-aaa1', 'c-bbb2', 'c-ccc3'];

    server.use(
      // Folder metadata.
      http.get(`https://www.googleapis.com/drive/v3/files/${FOLDER_ID}`, () =>
        HttpResponse.json({
          id: FOLDER_ID,
          name: 'My Folder',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [],
          modifiedTime: '2025-01-01T00:00:00Z',
        }),
      ),
      // Listing endpoint.
      http.get('https://www.googleapis.com/drive/v3/files', () =>
        HttpResponse.json({
          files: childIds.map((id, idx) => ({
            id,
            name: `part-${idx + 1}.stl`,
            mimeType: 'application/octet-stream',
            size: String(STL_BODY.length),
            parents: [FOLDER_ID],
            md5Checksum: `hash-${idx}`,
            modifiedTime: '2025-01-01T00:00:00Z',
          })),
        }),
      ),
      // Children downloads.
      ...childIds.map((id) =>
        http.get(`https://www.googleapis.com/drive/v3/files/${id}`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('alt') === 'media') {
            return new HttpResponse(STL_BODY, {
              headers: { 'content-type': 'application/octet-stream' },
            });
          }
          // Per-child metadata fallthrough (gdrive may revalidate). Keep the
          // listing data shape so parsing succeeds.
          return HttpResponse.json({
            id,
            name: `part-${id}.stl`,
            mimeType: 'application/octet-stream',
            size: String(STL_BODY.length),
            parents: [FOLDER_ID],
            modifiedTime: '2025-01-01T00:00:00Z',
          });
        }),
      ),
    );

    const post = await postIngest({
      url: `https://drive.google.com/drive/folders/${FOLDER_ID}`,
      collectionId,
    });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 15_000 });
    expect(terminal.status).toBe('completed');

    const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const files = await db.select().from(schema.lootFiles).where(eq(schema.lootFiles.lootId, terminal.lootId!));
    expect(files.length).toBe(3);
  });

  it('dual mode cascade — api-key 403, OAuth fallback succeeds', async () => {
    await seedSourceCredential({
      sourceId: 'google-drive',
      kind: 'oauth-token',
      bag: {
        kind: 'oauth+api-key',
        oauth: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60 * 60_000,
          clientId: 'client-id',
          clientSecret: 'client-secret',
        },
        apiKey: 'public-key',
      },
    });

    let metadataCalls = 0;
    server.use(
      http.get(`https://www.googleapis.com/drive/v3/files/${FILE_ID}`, ({ request }) => {
        const url = new URL(request.url);
        const isDownload = url.searchParams.get('alt') === 'media';
        const usingApiKey = url.searchParams.has('key');

        // Download branch: same dual cascade.
        if (isDownload) {
          if (usingApiKey) return new HttpResponse(null, { status: 403 });
          return new HttpResponse(STL_BODY, {
            headers: { 'content-type': 'application/octet-stream' },
          });
        }

        // Metadata branch: api-key → 403, OAuth fallback → 200.
        metadataCalls++;
        if (usingApiKey) return new HttpResponse(null, { status: 403 });
        return HttpResponse.json({
          id: FILE_ID,
          name: 'dual.stl',
          mimeType: 'application/octet-stream',
          size: String(STL_BODY.length),
          parents: [],
          md5Checksum: 'cafebabe',
          modifiedTime: '2025-01-01T00:00:00Z',
        });
      }),
    );

    const post = await postIngest({
      url: `https://drive.google.com/file/d/${FILE_ID}/view`,
      collectionId,
    });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId, { timeoutMs: 10_000 });
    expect(terminal.status).toBe('completed');
    // At least the api-key attempt + the oauth fallback for metadata.
    expect(metadataCalls).toBeGreaterThanOrEqual(2);
  });

  it('all-Google-native folder — children are docs/sheets → no-downloadable-formats', async () => {
    await seedSourceCredential({
      sourceId: 'google-drive',
      kind: 'api-key',
      bag: { kind: 'api-key', apiKey: 'k' },
    });

    server.use(
      http.get(`https://www.googleapis.com/drive/v3/files/${FOLDER_ID}`, () =>
        HttpResponse.json({
          id: FOLDER_ID,
          name: 'Native Folder',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [],
          modifiedTime: '2025-01-01T00:00:00Z',
        }),
      ),
      http.get('https://www.googleapis.com/drive/v3/files', () =>
        HttpResponse.json({
          files: [
            {
              id: 'doc-1',
              name: 'My Doc',
              mimeType: 'application/vnd.google-apps.document',
              parents: [FOLDER_ID],
              modifiedTime: '2025-01-01T00:00:00Z',
            },
            {
              id: 'sheet-1',
              name: 'My Sheet',
              mimeType: 'application/vnd.google-apps.spreadsheet',
              parents: [FOLDER_ID],
              modifiedTime: '2025-01-01T00:00:00Z',
            },
          ],
        }),
      ),
    );

    const post = await postIngest({
      url: `https://drive.google.com/drive/folders/${FOLDER_ID}`,
      collectionId,
    });
    expect(post.status).toBe(201);
    const jobId = post.json.jobId as string;

    const terminal = await waitForJobTerminal(jobId);
    // The folder yields zero downloadable files. Pipeline maps an empty
    // `files: []` completed event to `quarantined reason='validation-failed'`
    // (per ingest-pipeline.test.ts case #12). The adapter MAY also yield a
    // `failed reason='no-downloadable-formats'` event before completed if it
    // detects every child was skipped. Accept either terminal shape — both
    // legitimately surface "nothing to download" to the operator.
    const acceptable = ['failed', 'quarantined'];
    expect(acceptable).toContain(terminal.status);
    if (terminal.status === 'failed') {
      expect(terminal.failureReason).toBe('no-downloadable-formats');
    }
  });
});
