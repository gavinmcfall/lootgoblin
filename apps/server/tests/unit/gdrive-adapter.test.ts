/**
 * Unit tests — Google Drive adapter — V2-003-T8
 *
 * Tests the gdrive adapter in isolation. Uses the httpFetch option seam to
 * inject mock Responses; no real network, no DB, no pipeline.
 *
 * Coverage targets:
 *   1-7:    supports() — host allowlist + URL-shape parsing
 *   8-12:   URL parsing — file/folder/open/doc-shaped/resourcekey/malformed
 *   13-19:  credential validation (oauth/api-key/oauth+api-key shapes)
 *   20-21:  missing credentials (auth-required reason='missing')
 *   22-25:  Mode B (API-key) public file — query param + resource key header
 *   26-28:  Mode A (OAuth) private file — Bearer header + redirect strip
 *   29-30:  Dual mode (oauth+api-key) — try API-key first, fall back to OAuth
 *   31-34:  Token refresh (happy + invalid_grant + callback throw + non-rotation)
 *   35-39:  Folder recursion + caps + Google-native skips + pagination
 *   40-42:  Rate-limit + 5xx (inherited T7 patterns)
 *   43-47:  Error mapping (404 / 401 / stream error / abort)
 *   48-49:  Filename + dedup-counter staging
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { createGdriveAdapter } from '../../src/scavengers/adapters/gdrive';
import type { FetchContext, FetchTarget, ScavengerEvent } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// Test fixtures + helpers
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

const TEST_API_BASE = 'https://api.test.example/drive/v3';
const TEST_TOKEN_ENDPOINT = 'https://test.example/oauth2/token';

const FILE_ID = 'fileid_abcdef123456';
const FOLDER_ID = 'folderid_abcdef123456';
const FILE_URL = `https://drive.google.com/file/d/${FILE_ID}/view?usp=sharing`;
const FOLDER_URL = `https://drive.google.com/drive/folders/${FOLDER_ID}`;
const OPEN_URL = `https://drive.google.com/open?id=${FILE_ID}`;
const DOC_URL = `https://docs.google.com/document/d/${FILE_ID}/edit`;

async function makeStagingDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-gdrive-test-'));
  dirsToClean.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirsToClean.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeCtx(opts?: {
  stagingDir?: string;
  credentials?: Record<string, unknown> | undefined;
  signal?: AbortSignal;
  onTokenRefreshed?: (c: Record<string, unknown>) => Promise<void> | void;
}): FetchContext {
  return {
    userId: crypto.randomUUID(),
    stagingDir: opts?.stagingDir ?? '',
    credentials: opts?.credentials,
    signal: opts?.signal,
    onTokenRefreshed: opts?.onTokenRefreshed,
  };
}

function urlTarget(url: string): FetchTarget {
  return { kind: 'url', url };
}
function sourceItemIdTarget(id: string): FetchTarget {
  return { kind: 'source-item-id', sourceItemId: id };
}
function rawTarget(): FetchTarget {
  return { kind: 'raw', payload: { foo: 'bar' } };
}

function oauthCreds(overrides?: Partial<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  clientSecret: string;
}>) {
  return {
    kind: 'oauth' as const,
    accessToken: overrides?.accessToken ?? 'access-tok-gd',
    refreshToken: overrides?.refreshToken ?? 'refresh-tok-gd',
    expiresAt: overrides?.expiresAt ?? Date.now() + 60 * 60 * 1000,
    clientId: overrides?.clientId ?? 'client-id-x',
    clientSecret: overrides?.clientSecret ?? 'client-secret-y',
  };
}

function apiKeyCreds(apiKey = 'api-key-public') {
  return { kind: 'api-key' as const, apiKey };
}

function dualCreds(opts?: {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  apiKey?: string;
}) {
  return {
    kind: 'oauth+api-key' as const,
    apiKey: opts?.apiKey ?? 'api-key-public',
    oauth: {
      accessToken: opts?.accessToken ?? 'access-tok-gd',
      refreshToken: opts?.refreshToken ?? 'refresh-tok-gd',
      expiresAt: opts?.expiresAt ?? Date.now() + 60 * 60 * 1000,
      clientId: 'client-id-x',
      clientSecret: 'client-secret-y',
    },
  };
}

const fileMeta = {
  id: FILE_ID,
  name: 'cool-model.stl',
  mimeType: 'application/octet-stream',
  size: '12345',
  parents: ['root'],
  md5Checksum: 'abc123',
  modifiedTime: '2024-01-15T10:30:00Z',
  description: 'Cool STL',
  owners: [{ displayName: 'Maker Mike', emailAddress: 'mm@example.com' }],
};

const folderMeta = {
  id: FOLDER_ID,
  name: 'My 3D Folder',
  mimeType: 'application/vnd.google-apps.folder',
  parents: ['root'],
  modifiedTime: '2024-01-10T08:00:00Z',
  owners: [{ displayName: 'Maker Mike' }],
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fileResponse(content: string | Buffer = 'fake-bytes', headers: Record<string, string> = {}): Response {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const stream = Readable.toWeb(Readable.from([buf])) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
  });
}

function rateLimitedResponse(retryAfter?: string): Response {
  const headers: Record<string, string> = {};
  if (retryAfter) headers['retry-after'] = retryAfter;
  return new Response(null, { status: 429, headers });
}

async function collect(
  adapter: ReturnType<typeof createGdriveAdapter>,
  ctx: FetchContext,
  target: FetchTarget,
): Promise<ScavengerEvent[]> {
  const events: ScavengerEvent[] = [];
  for await (const evt of adapter.fetch(ctx, target)) events.push(evt);
  return events;
}

function makeAdapter(httpFetch: ReturnType<typeof vi.fn>, extra?: { retryBaseMs?: number; maxRetries?: number }) {
  return createGdriveAdapter({
    httpFetch: httpFetch as unknown as typeof fetch,
    apiBase: TEST_API_BASE,
    tokenEndpoint: TEST_TOKEN_ENDPOINT,
    retryBaseMs: extra?.retryBaseMs,
    maxRetries: extra?.maxRetries,
  });
}

// ---------------------------------------------------------------------------
// 1-7: supports()
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — supports()', () => {
  const adapter = createGdriveAdapter();

  it('test 1: drive.google.com /file/d/<id>/view → true', () => {
    expect(adapter.supports(FILE_URL)).toBe(true);
  });

  it('test 2: drive.google.com /drive/folders/<id> → true', () => {
    expect(adapter.supports(FOLDER_URL)).toBe(true);
  });

  it('test 3: drive.google.com /open?id=<id> → true', () => {
    expect(adapter.supports(OPEN_URL)).toBe(true);
  });

  it('test 4: docs.google.com /document/d/<id> → true (doc-shaped)', () => {
    expect(adapter.supports(DOC_URL)).toBe(true);
  });

  it('test 5: other hosts → false', () => {
    expect(adapter.supports('https://mail.google.com/something')).toBe(false);
    expect(adapter.supports('https://drive.evil.com/file/d/x/view')).toBe(false);
    expect(adapter.supports('https://other-site.com/path')).toBe(false);
  });

  it('test 6: api.drive.google.com → false (exact-host allowlist, T3-L9)', () => {
    expect(adapter.supports('https://api.drive.google.com/file/d/foo/view')).toBe(false);
  });

  it('test 7: malformed URLs → false', () => {
    expect(adapter.supports('not-a-url')).toBe(false);
    expect(adapter.supports('')).toBe(false);
    expect(adapter.supports('https://drive.google.com/feed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8-12: URL parsing edge cases (via fetch behaviour)
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — URL parsing', () => {
  it('test 8: file URL with resourcekey → X-Goog-Drive-Resource-Keys header sent', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const url = `${FILE_URL}&resourcekey=rk-12345`;
    await collect(adapter, ctx, urlTarget(url));

    const metaInit = httpFetch.mock.calls[0]![1] as RequestInit;
    const headers = metaInit.headers as Record<string, string>;
    expect(headers['X-Goog-Drive-Resource-Keys']).toBe(`${FILE_ID}/rk-12345`);
  });

  it('test 9: folder URL with resourcekey on /drive/folders/ → header on listing', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta)) // folder metadata
      .mockResolvedValueOnce(jsonResponse({ files: [{ ...fileMeta }] })) // listing page 1
      .mockResolvedValueOnce(fileResponse('bytes')); // file download

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const url = `${FOLDER_URL}?resourcekey=rk-folder`;
    await collect(adapter, ctx, urlTarget(url));

    // Listing call (call index 1) should also carry the resource-key header.
    const listInit = httpFetch.mock.calls[1]![1] as RequestInit;
    const listHeaders = listInit.headers as Record<string, string>;
    expect(listHeaders['X-Goog-Drive-Resource-Keys']).toBe(`${FOLDER_ID}/rk-folder`);
  });

  it('test 10: /open?id= URL → metadata fetched then disambiguated', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(OPEN_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 11: docs.google.com URL → metadata fetched, then no-downloadable-formats', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        ...fileMeta,
        mimeType: 'application/vnd.google-apps.document',
        name: 'Some Doc',
      }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(DOC_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('no-downloadable-formats');
  });

  it('test 12: source-item-id target → treated as file id, metadata disambiguates', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, sourceItemIdTarget('direct-id-from-db'));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');

    // First call should have hit /files/<direct-id-from-db>
    const firstUrl = httpFetch.mock.calls[0]![0] as string;
    expect(firstUrl).toContain('/files/direct-id-from-db');
  });
});

// ---------------------------------------------------------------------------
// 13-19: credential validation
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — credential validation', () => {
  it('test 13: oauth missing accessToken → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { kind: 'oauth', refreshToken: 'r', expiresAt: 0, clientId: 'c', clientSecret: 's' },
    });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/missing accessToken/);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 14: oauth missing refreshToken → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { kind: 'oauth', accessToken: 'a', expiresAt: 0, clientId: 'c', clientSecret: 's' },
    });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.details).toMatch(/missing refreshToken/);
  });

  it('test 15: api-key missing apiKey → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: { kind: 'api-key' } });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/missing apiKey/);
  });

  it('test 16: oauth+api-key missing apiKey → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: {
        kind: 'oauth+api-key',
        oauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: 0,
          clientId: 'c',
          clientSecret: 's',
        },
      },
    });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.details).toMatch(/oauth\+api-key.*missing apiKey/);
  });

  it('test 17: oauth+api-key missing nested oauth fields → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { kind: 'oauth+api-key', apiKey: 'k', oauth: { accessToken: 'a' } },
    });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.details).toMatch(/nested oauth/);
  });

  it('test 18: invalid kind discriminator → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: { kind: 'cookies', stuff: 'x' } });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/kind discriminator/);
  });

  it('test 19: raw target → failed mentioning "url or source-item-id"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, rawTarget());
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.details).toMatch(/url or source-item-id/);
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 20-21: missing credentials → auth-required reason='missing'
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — missing credentials semantics', () => {
  it('test 20: undefined credentials + url target → auth-required(missing) + failed(auth-revoked)', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: undefined });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const authReq = events.find((e) => e.kind === 'auth-required');
    expect(authReq).toBeDefined();
    if (authReq?.kind !== 'auth-required') return;
    expect(authReq.reason).toBe('missing');

    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 21: undefined credentials + source-item-id target → no auth-required (just failed)', async () => {
    // Spec: 'missing' is yielded only for url target (the "user pasted public link" flow).
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: undefined });

    const events = await collect(adapter, ctx, sourceItemIdTarget(FILE_ID));
    const authReq = events.find((e) => e.kind === 'auth-required');
    expect(authReq).toBeUndefined();

    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
  });
});

// ---------------------------------------------------------------------------
// 22-25: Mode B (API key)
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — Mode B (API-key)', () => {
  it('test 22: public file with API key → ?key=… on metadata + download', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds('SECRET-KEY') });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');

    const metaUrl = httpFetch.mock.calls[0]![0] as string;
    expect(metaUrl).toContain('key=SECRET-KEY');

    const dlUrl = httpFetch.mock.calls[1]![0] as string;
    expect(dlUrl).toContain('alt=media');
    expect(dlUrl).toContain('key=SECRET-KEY');
  });

  it('test 23: API-key request must NOT carry Authorization header', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    await collect(adapter, ctx, urlTarget(FILE_URL));

    const metaInit = httpFetch.mock.calls[0]![1] as RequestInit;
    const headers = metaInit.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('test 24: completed item populates sourceUrl, creator, modifiedTime', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    const item = last.item;
    expect(item.sourceId).toBe('google-drive');
    expect(item.sourceItemId).toBe(FILE_ID);
    expect(item.title).toBe('cool-model.stl');
    expect(item.creator).toBe('Maker Mike');
    expect(item.sourcePublishedAt).toBeInstanceOf(Date);
    expect(item.files).toHaveLength(1);
    expect(item.files[0]!.suggestedName).toBe('cool-model.stl');
  });

  it('test 25: resource key URL forwards X-Goog-Drive-Resource-Keys on download too', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    await collect(adapter, ctx, urlTarget(`${FILE_URL}&resourcekey=rk-xyz`));

    const dlInit = httpFetch.mock.calls[1]![1] as RequestInit;
    const dlHeaders = dlInit.headers as Record<string, string>;
    expect(dlHeaders['X-Goog-Drive-Resource-Keys']).toBe(`${FILE_ID}/rk-xyz`);
  });
});

// ---------------------------------------------------------------------------
// 26-28: Mode A (OAuth)
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — Mode A (OAuth)', () => {
  it('test 26: private file with OAuth → Authorization: Bearer on metadata + initial download', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: oauthCreds({ accessToken: 'tok-abc' }) });

    await collect(adapter, ctx, urlTarget(FILE_URL));

    const metaInit = httpFetch.mock.calls[0]![1] as RequestInit;
    expect((metaInit.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-abc');

    const dlInit = httpFetch.mock.calls[1]![1] as RequestInit;
    expect((dlInit.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-abc');
  });

  it('test 27: download redirect target fetched WITHOUT Authorization (T7-L3)', async () => {
    // First metadata fetch.
    // Then download endpoint returns 302 to signed CDN URL.
    // Adapter must follow the redirect manually with NO Authorization header.
    const redirectRes = new Response(null, {
      status: 302,
      headers: { location: 'https://cdn.example.com/signed/abc' },
    });

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(redirectRes)
      .mockResolvedValueOnce(fileResponse('content-from-cdn'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: oauthCreds({ accessToken: 'tok-abc' }) });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');

    // Third call (the redirect target) must have no Authorization header.
    const cdnInit = httpFetch.mock.calls[2]![1] as RequestInit;
    const headers = cdnInit.headers as Record<string, string> | undefined;
    if (headers) {
      expect(headers['Authorization']).toBeUndefined();
    } else {
      expect(headers).toBeUndefined();
    }
    expect(httpFetch.mock.calls[2]![0]).toBe('https://cdn.example.com/signed/abc');
  });

  it('test 28: OAuth metadata 401 → auth-required(revoked) + failed(auth-revoked)', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: oauthCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const authReq = events.find((e) => e.kind === 'auth-required');
    expect(authReq).toBeDefined();
    if (authReq?.kind !== 'auth-required') return;
    expect(authReq.reason).toBe('revoked');

    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
  });
});

// ---------------------------------------------------------------------------
// 29-30: Dual mode (oauth+api-key)
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — Dual mode (oauth+api-key)', () => {
  it('test 29: public file → API key path succeeds, OAuth not invoked', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta)) // metadata via API key
      .mockResolvedValueOnce(fileResponse('content')); // download via API key

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: dualCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');

    // First call must NOT carry Authorization (API-key first).
    const metaInit = httpFetch.mock.calls[0]![1] as RequestInit;
    const headers = metaInit.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect((httpFetch.mock.calls[0]![0] as string)).toContain('key=api-key-public');

    // Two calls total — no OAuth fallback.
    expect(httpFetch).toHaveBeenCalledTimes(2);
  });

  it('test 30: private file → API key 403 → adapter falls back to OAuth and completes', async () => {
    const httpFetch = vi.fn()
      // First metadata attempt — API key rejected.
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      // Second metadata attempt — OAuth succeeds.
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      // Download via OAuth.
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: dualCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');

    // Second call (the OAuth retry) must carry Authorization.
    const oauthInit = httpFetch.mock.calls[1]![1] as RequestInit;
    expect((oauthInit.headers as Record<string, string>)['Authorization']).toBe('Bearer access-tok-gd');
  });
});

// ---------------------------------------------------------------------------
// 31-34: Token refresh
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — token refresh', () => {
  it('test 31: near-expiry triggers refresh; onTokenRefreshed receives new bag with preserved refreshToken', async () => {
    const httpFetch = vi.fn()
      // refresh POST — Google does not return refresh_token
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'new-tok',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'drive.readonly',
      }))
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const onTokenRefreshed = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ refreshToken: 'persist-me', expiresAt: Date.now() + 30_000 }),
      onTokenRefreshed,
    });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));

    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    const newBag = onTokenRefreshed.mock.calls[0]![0] as Record<string, unknown>;
    expect(newBag['kind']).toBe('oauth');
    expect(newBag['accessToken']).toBe('new-tok');
    // Google does NOT rotate refreshToken — preserve original.
    expect(newBag['refreshToken']).toBe('persist-me');

    // Token endpoint is POST with form body.
    expect(httpFetch.mock.calls[0]![0]).toBe(TEST_TOKEN_ENDPOINT);
    const tokenInit = httpFetch.mock.calls[0]![1] as RequestInit;
    expect(tokenInit.method).toBe('POST');
    expect(String(tokenInit.body)).toContain('grant_type=refresh_token');

    // Downstream metadata uses NEW token.
    const metaInit = httpFetch.mock.calls[1]![1] as RequestInit;
    expect((metaInit.headers as Record<string, string>)['Authorization']).toBe('Bearer new-tok');

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 32: refresh 400 invalid_grant → auth-required(revoked) + failed(auth-revoked)', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 400 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() - 10_000 }),
    });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const authReq = events.find((e) => e.kind === 'auth-required');
    expect(authReq).toBeDefined();
    if (authReq?.kind !== 'auth-required') return;
    expect(authReq.reason).toBe('revoked');

    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
  });

  it('test 33: onTokenRefreshed callback throws → fetch still completes', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new-tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const onTokenRefreshed = vi.fn().mockRejectedValue(new Error('persist failed'));
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() + 30_000 }),
      onTokenRefreshed,
    });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 34: dual creds with near-expiry oauth → refresh, new bag preserves apiKey', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new-tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const onTokenRefreshed = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: dualCreds({ expiresAt: Date.now() + 30_000, apiKey: 'KEEP-ME' }),
      onTokenRefreshed,
    });

    await collect(adapter, ctx, urlTarget(FILE_URL));

    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    const newBag = onTokenRefreshed.mock.calls[0]![0] as Record<string, unknown>;
    expect(newBag['kind']).toBe('oauth+api-key');
    expect(newBag['apiKey']).toBe('KEEP-ME');
    const nestedOauth = newBag['oauth'] as Record<string, unknown>;
    expect(nestedOauth['accessToken']).toBe('new-tok');
  });
});

// ---------------------------------------------------------------------------
// 35-39: Folder recursion + caps
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — folder recursion', () => {
  it('test 35: flat folder with 3 files → all 3 ingested', async () => {
    const child1 = { ...fileMeta, id: 'c1', name: 'a.stl' };
    const child2 = { ...fileMeta, id: 'c2', name: 'b.stl' };
    const child3 = { ...fileMeta, id: 'c3', name: 'c.stl' };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta)) // folder metadata
      .mockResolvedValueOnce(jsonResponse({ files: [child1, child2, child3] })) // listing
      .mockResolvedValueOnce(fileResponse('a-bytes'))
      .mockResolvedValueOnce(fileResponse('b-bytes'))
      .mockResolvedValueOnce(fileResponse('c-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FOLDER_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(3);
    expect(last.item.title).toBe('My 3D Folder');
  });

  it('test 36: nested folder (2 levels) → both levels ingested', async () => {
    const subfolder = {
      id: 'sub1',
      name: 'inner',
      mimeType: 'application/vnd.google-apps.folder',
    };
    const topFile = { ...fileMeta, id: 'top1', name: 'top.stl' };
    const innerFile = { ...fileMeta, id: 'in1', name: 'inner.stl' };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta)) // top folder meta
      .mockResolvedValueOnce(jsonResponse({ files: [topFile, subfolder] })) // top listing
      .mockResolvedValueOnce(jsonResponse({ files: [innerFile] })) // sub listing
      .mockResolvedValueOnce(fileResponse('top-bytes'))
      .mockResolvedValueOnce(fileResponse('inner-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FOLDER_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(2);
  });

  it('test 37: folder with mix of files + Google-natives → docs skipped silently, files ingested', async () => {
    const stl = { ...fileMeta, id: 's1', name: 'model.stl' };
    const doc = {
      id: 'd1',
      name: 'README',
      mimeType: 'application/vnd.google-apps.document',
    };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta))
      .mockResolvedValueOnce(jsonResponse({ files: [stl, doc] }))
      .mockResolvedValueOnce(fileResponse('stl-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FOLDER_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(1);
    // A progress event mentioning the skipped Google-native exists.
    const skipEvent = events.find(
      (e) => e.kind === 'progress' && e.message.includes('skipped Google-native'),
    );
    expect(skipEvent).toBeDefined();
  });

  it('test 38: folder with ONLY Google-natives → fails no-downloadable-formats', async () => {
    const doc1 = { id: 'd1', name: 'A', mimeType: 'application/vnd.google-apps.document' };
    const sheet1 = { id: 'd2', name: 'B', mimeType: 'application/vnd.google-apps.spreadsheet' };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta))
      .mockResolvedValueOnce(jsonResponse({ files: [doc1, sheet1] }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FOLDER_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('no-downloadable-formats');
    expect(last.details).toMatch(/My 3D Folder/);
    expect(last.details).toMatch(/2/); // skip count
  });

  it('test 39: pagination — multiple pages combined', async () => {
    const pageA = [
      { ...fileMeta, id: 'p1', name: 'a.stl' },
      { ...fileMeta, id: 'p2', name: 'b.stl' },
    ];
    const pageB = [
      { ...fileMeta, id: 'p3', name: 'c.stl' },
    ];

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta))
      .mockResolvedValueOnce(jsonResponse({ files: pageA, nextPageToken: 'NEXT' }))
      .mockResolvedValueOnce(jsonResponse({ files: pageB }))
      .mockResolvedValueOnce(fileResponse('a-bytes'))
      .mockResolvedValueOnce(fileResponse('b-bytes'))
      .mockResolvedValueOnce(fileResponse('c-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FOLDER_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(3);

    // The second listing call must include the pageToken.
    const secondListUrl = httpFetch.mock.calls[2]![0] as string;
    expect(secondListUrl).toContain('pageToken=NEXT');
  });

  it('test 39b: maxFiles cap → ingestion stops at cap with progress event', async () => {
    const a = { ...fileMeta, id: 'a', name: 'a.stl' };
    const b = { ...fileMeta, id: 'b', name: 'b.stl' };
    const c = { ...fileMeta, id: 'c', name: 'c.stl' };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta))
      .mockResolvedValueOnce(jsonResponse({ files: [a, b, c] }))
      .mockResolvedValueOnce(fileResponse('a-bytes'))
      .mockResolvedValueOnce(fileResponse('b-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { ...apiKeyCreds(), caps: { maxFiles: 2 } } as Record<string, unknown>,
    });

    const events = await collect(adapter, ctx, urlTarget(FOLDER_URL));
    const capEvent = events.find(
      (e) => e.kind === 'progress' && e.message.includes('file-count cap'),
    );
    expect(capEvent).toBeDefined();
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(2);
  });

  it('test 39c: maxDepth cap → recursion stops at depth, progress event emitted', async () => {
    const subfolder = {
      id: 'sub1',
      name: 'inner',
      mimeType: 'application/vnd.google-apps.folder',
    };
    const topFile = { ...fileMeta, id: 'top1', name: 'top.stl' };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta))
      .mockResolvedValueOnce(jsonResponse({ files: [topFile, subfolder] }))
      .mockResolvedValueOnce(fileResponse('top-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { ...apiKeyCreds(), caps: { maxDepth: 1 } } as Record<string, unknown>,
    });

    const events = await collect(adapter, ctx, urlTarget(FOLDER_URL));
    const capEvent = events.find(
      (e) => e.kind === 'progress' && e.message.includes('max-depth'),
    );
    expect(capEvent).toBeDefined();
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(1); // only top-level file
  });

  it('test 39d: maxBytes cap → ingestion stops before exceeding budget', async () => {
    const a = { ...fileMeta, id: 'a', name: 'a.stl', size: '100' };
    const b = { ...fileMeta, id: 'b', name: 'b.stl', size: '100' };
    const c = { ...fileMeta, id: 'c', name: 'c.stl', size: '100' };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta))
      .mockResolvedValueOnce(jsonResponse({ files: [a, b, c] }))
      .mockResolvedValueOnce(fileResponse('a-bytes'))
      .mockResolvedValueOnce(fileResponse('b-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { ...apiKeyCreds(), caps: { maxBytes: 250 } } as Record<string, unknown>,
    });

    const events = await collect(adapter, ctx, urlTarget(FOLDER_URL));
    const capEvent = events.find(
      (e) => e.kind === 'progress' && e.message.includes('byte cap'),
    );
    expect(capEvent).toBeDefined();
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 40-42: rate-limit + 5xx
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — rate-limit + 5xx', () => {
  it('test 40: 429 once then 200 → rate-limited event then completes', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(rateLimitedResponse('1'))
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const rl = events.find((e) => e.kind === 'rate-limited');
    expect(rl).toBeDefined();
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 41: 6× 429 → rate-limit-exhausted', async () => {
    const httpFetch = vi.fn().mockResolvedValue(rateLimitedResponse());
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('rate-limit-exhausted');
  });

  it('test 42: 503 once then 200 → completes (5xx unified retry)', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 43-47: error mapping + abort + stream errors
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — error mapping', () => {
  it('test 43: metadata 404 → content-removed', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('content-removed');
  });

  it('test 44: download 404 → content-removed', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('content-removed');
  });

  it('test 45: stream error mid-download → partial file unlinked + network-error', async () => {
    function makeErroringStream(): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error('network drop mid-stream'));
        },
      });
    }
    const erroringFile = new Response(makeErroringStream(), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fileMeta))
      .mockResolvedValueOnce(erroringFile);

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/stream/i);

    const remaining = await fsp.readdir(stagingDir);
    expect(remaining).toHaveLength(0);
  });

  it('test 46: pre-aborted signal → failed reason=network-error', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const httpFetch = vi.fn().mockRejectedValue(abortErr);

    const controller = new AbortController();
    controller.abort();

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds(), signal: controller.signal });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('network-error');
    expect(last.error).toBeDefined();
  });

  it('test 47: token refresh fetch error populates failed.error', async () => {
    const refreshErr = new Error('connect ECONNREFUSED');
    const httpFetch = vi.fn().mockRejectedValueOnce(refreshErr);

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() - 1000 }),
    });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('network-error');
    expect(last.error).toBe(refreshErr);
  });
});

// ---------------------------------------------------------------------------
// 48-49: file naming + dedup
// ---------------------------------------------------------------------------

describe('createGdriveAdapter — filename + dedup', () => {
  it('test 48: suggestedName from metadata.name (sanitized)', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...fileMeta, name: '../../etc/passwd' }))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FILE_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    // sanitizer strips path traversal — final basename is "passwd".
    expect(last.item.files[0]!.suggestedName).toBe('passwd');
  });

  it('test 49: duplicate file names from sibling subfolders → suffixed dedup', async () => {
    // Two children named "model.stl" coming from a flat folder should produce
    // distinct staged file names: "model.stl" and "model_2.stl".
    const a = { ...fileMeta, id: 'a', name: 'model.stl' };
    const b = { ...fileMeta, id: 'b', name: 'model.stl' };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(folderMeta))
      .mockResolvedValueOnce(jsonResponse({ files: [a, b] }))
      .mockResolvedValueOnce(fileResponse('a-bytes'))
      .mockResolvedValueOnce(fileResponse('b-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiKeyCreds() });

    const events = await collect(adapter, ctx, urlTarget(FOLDER_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    const names = last.item.files.map((f) => f.suggestedName);
    expect(names).toContain('model.stl');
    expect(names).toContain('model_2.stl');
  });
});
