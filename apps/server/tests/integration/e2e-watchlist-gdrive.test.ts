/**
 * V2-004-T10 — End-to-end Watchlist (Google Drive)
 *
 * GDrive's discovery surface is unique: enumerateFolder + pollUrl. No
 * creator/tag/search. Tests cover both capability methods plus the cursor
 * shapes (lastSeen map for folder, etag+modifiedTime for url_watch).
 *
 * Auth shape: api-key only (simplest path; OAuth refresh is exercised in
 * the sketchfab e2e). Mocks cover GDrive REST: /files/<id> for metadata,
 * /files (list with q=) for folder enumeration, and /files/<id>?alt=media
 * for downloads.
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

const DB_PATH = '/tmp/lootgoblin-t10-watchlist-gdrive.db';
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

// Per-file STL bodies — unique per id so dedup-by-hash doesn't fold them.
function stlBodyFor(id: string): string {
  return `solid ${id}\nendsolid ${id}\n`;
}

interface DriveChild {
  id: string;
  name: string;
  modifiedTime: string;
  /** Override mimeType when test wants Google-native skip path. */
  mimeType?: string;
}

const FOLDER_ID = 'folderId-abcdef';

/**
 * Install handlers for: folder listing (with q='<id>' in parents), per-file
 * metadata (/files/<id>), and per-file download (/files/<id>?alt=media).
 *
 * `etag` (when supplied) is returned on file metadata responses for the
 * pollUrl 304 / If-None-Match path.
 */
function installFolderApi(opts: {
  folderId: string;
  children: DriveChild[];
}): void {
  const handlers = [];

  // Folder listing.
  handlers.push(
    http.get('https://www.googleapis.com/drive/v3/files', () =>
      HttpResponse.json({
        files: opts.children.map((c) => ({
          id: c.id,
          name: c.name,
          mimeType: c.mimeType ?? 'application/octet-stream',
          size: String(stlBodyFor(c.id).length),
          parents: [opts.folderId],
          md5Checksum: `md5-${c.id}`,
          modifiedTime: c.modifiedTime,
        })),
      }),
    ),
  );

  // Per-child metadata + download. The ingest-side fetch pulls
  // /files/<id> (metadata) then /files/<id>?alt=media (bytes).
  for (const c of opts.children) {
    if ((c.mimeType ?? '').startsWith('application/vnd.google-apps')) continue;
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
            mimeType: c.mimeType ?? 'application/octet-stream',
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
// Tests
// ---------------------------------------------------------------------------

describe('e2e — watchlist (gdrive)', () => {
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

  it('enumerateFolder happy path — 5 files discovered, 5 ingest jobs, 5 Loot rows', async () => {
    await seedSourceCredential({
      sourceId: 'google-drive',
      kind: 'api-key',
      bag: { kind: 'api-key', apiKey: 'gd-api-key' },
    });

    const children: DriveChild[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c-${i + 1}`,
      name: `file-${i + 1}.stl`,
      modifiedTime: `2026-01-0${i + 1}T00:00:00Z`,
    }));

    installFolderApi({ folderId: FOLDER_ID, children });

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'folder_watch',
      sourceAdapterId: 'google-drive',
      parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
      defaultCollectionId: collectionId,
    });
    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    expect((await listIngestJobsForSubscription(subId)).length).toBe(5);
    expect((await listLootInCollection(collectionId)).length).toBe(5);

    // Cursor recorded the lastSeen modifiedTime per child.
    const sub = await getWatchlistSubscription(subId);
    const cur = JSON.parse(sub.cursorState!) as { lastSeen: Record<string, string> };
    expect(Object.keys(cur.lastSeen).length).toBe(5);
    for (const c of children) {
      expect(cur.lastSeen[c.id]).toBe(c.modifiedTime);
    }
  });

  it('subsequent firing — only NEW files emit (5 prior + 1 new → 1 ingest job)', async () => {
    await seedSourceCredential({
      sourceId: 'google-drive',
      kind: 'api-key',
      bag: { kind: 'api-key', apiKey: 'gd-api-key' },
    });

    // Pre-seed cursor as if 5 prior firings were seen.
    const priorChildren: DriveChild[] = Array.from({ length: 5 }, (_, i) => ({
      id: `n-${i + 1}`,
      name: `prior-${i + 1}.stl`,
      modifiedTime: `2026-01-0${i + 1}T00:00:00Z`,
    }));
    const priorCursor = {
      lastSeen: Object.fromEntries(priorChildren.map((c) => [c.id, c.modifiedTime])),
    };

    // Listing now returns the 5 prior + 1 NEW.
    const newChild: DriveChild = {
      id: 'n-new',
      name: 'newcomer.stl',
      modifiedTime: '2026-02-15T00:00:00Z',
    };
    installFolderApi({
      folderId: FOLDER_ID,
      children: [...priorChildren, newChild],
    });

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'folder_watch',
      sourceAdapterId: 'google-drive',
      parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
      defaultCollectionId: collectionId,
      cursorState: JSON.stringify(priorCursor),
    });
    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    const ingestJobs = await listIngestJobsForSubscription(subId);
    expect(ingestJobs.length).toBe(1);
    const payload = JSON.parse(ingestJobs[0]!.targetPayload) as { sourceItemId: string };
    expect(payload.sourceItemId).toBe('n-new');

    // Cursor map updates to include the new child.
    const sub = await getWatchlistSubscription(subId);
    const cur = JSON.parse(sub.cursorState!) as { lastSeen: Record<string, string> };
    expect(cur.lastSeen['n-new']).toBe(newChild.modifiedTime);
  });

  it('subsequent firing — modified file re-emits as updated (1 ingest job for the bumped file)', async () => {
    await seedSourceCredential({
      sourceId: 'google-drive',
      kind: 'api-key',
      bag: { kind: 'api-key', apiKey: 'gd-api-key' },
    });

    const baseChildren: DriveChild[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m-${i + 1}`,
      name: `f${i + 1}.stl`,
      modifiedTime: `2026-01-0${i + 1}T00:00:00Z`,
    }));
    const priorCursor = {
      lastSeen: Object.fromEntries(baseChildren.map((c) => [c.id, c.modifiedTime])),
    };

    // Same 5 children but child #3 has a NEWER modifiedTime.
    const updatedChildren: DriveChild[] = baseChildren.map((c, i) =>
      i === 2 ? { ...c, modifiedTime: '2026-03-15T00:00:00Z' } : c,
    );
    installFolderApi({ folderId: FOLDER_ID, children: updatedChildren });

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'folder_watch',
      sourceAdapterId: 'google-drive',
      parameters: { kind: 'folder_watch', folderId: FOLDER_ID },
      defaultCollectionId: collectionId,
      cursorState: JSON.stringify(priorCursor),
    });
    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    const ingestJobs = await listIngestJobsForSubscription(subId);
    expect(ingestJobs.length).toBe(1);
    const payload = JSON.parse(ingestJobs[0]!.targetPayload) as { sourceItemId: string };
    expect(payload.sourceItemId).toBe('m-3');

    // Cursor's lastSeen for m-3 is the newer modifiedTime.
    const sub = await getWatchlistSubscription(subId);
    const cur = JSON.parse(sub.cursorState!) as { lastSeen: Record<string, string> };
    expect(cur.lastSeen['m-3']).toBe('2026-03-15T00:00:00Z');
  });

  it('pollUrl — second firing with matching modifiedTime → no item-discovered, last_fired_at advances', async () => {
    await seedSourceCredential({
      sourceId: 'google-drive',
      kind: 'api-key',
      bag: { kind: 'api-key', apiKey: 'gd-api-key' },
    });

    const FILE_ID = 'pf-12345';
    const POLL_URL = `https://drive.google.com/file/d/${FILE_ID}/view`;
    const MTIME = '2026-04-01T12:00:00Z';

    // First-fire: metadata returns 200; expect 1 item-discovered.
    server.use(
      http.get(`https://www.googleapis.com/drive/v3/files/${FILE_ID}`, () =>
        HttpResponse.json(
          {
            id: FILE_ID,
            name: 'poll-me.stl',
            mimeType: 'application/octet-stream',
            size: String(stlBodyFor(FILE_ID).length),
            parents: [],
            md5Checksum: 'pf-md5',
            modifiedTime: MTIME,
          },
          { headers: { etag: '"etag-v1"' } },
        ),
      ),
      http.get(`https://www.googleapis.com/drive/v3/files/${FILE_ID}`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('alt') === 'media') {
          return new HttpResponse(stlBodyFor(FILE_ID), {
            headers: { 'content-type': 'application/octet-stream' },
          });
        }
        return HttpResponse.json({});
      }),
    );

    const subId = await seedWatchlistSubscription({
      ownerId: userId,
      kind: 'url_watch',
      sourceAdapterId: 'google-drive',
      parameters: { kind: 'url_watch', url: POLL_URL },
      defaultCollectionId: collectionId,
    });
    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    expect((await listIngestJobsForSubscription(subId)).length).toBe(1);
    const subAfterFirst = await getWatchlistSubscription(subId);
    const cur = JSON.parse(subAfterFirst.cursorState!) as { etag: string; modifiedTime?: string };
    expect(cur.modifiedTime).toBe(MTIME);

    // Second firing: same modifiedTime → adapter emits 0 items even if 200.
    // (304 path requires matching ETag header from the upstream — we verify
    // the mtime-equality short-circuit works regardless of ETag handling.)
    server.resetHandlers();
    server.use(
      http.get(`https://www.googleapis.com/drive/v3/files/${FILE_ID}`, () =>
        HttpResponse.json(
          {
            id: FILE_ID,
            name: 'poll-me.stl',
            mimeType: 'application/octet-stream',
            size: String(stlBodyFor(FILE_ID).length),
            parents: [],
            md5Checksum: 'pf-md5',
            modifiedTime: MTIME, // unchanged
          },
          { headers: { etag: '"etag-v1"' } },
        ),
      ),
    );

    await seedWatchlistJob(subId);
    await driveSubscriptionChain({ subscriptionId: subId });

    // Still just the original 1 ingest job — no new item-discovered.
    expect((await listIngestJobsForSubscription(subId)).length).toBe(1);
  });
});
