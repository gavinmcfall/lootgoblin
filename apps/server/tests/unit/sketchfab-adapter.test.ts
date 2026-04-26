/**
 * Unit tests — Sketchfab adapter — V2-003-T7
 *
 * Tests the sketchfab adapter in isolation (no real network, no DB,
 * no pipeline). Uses the httpFetch option seam to inject mock Responses.
 *
 * First OAuth-flow adapter; coverage targets:
 *   1-5:   supports() — host + UID extraction
 *   6-12:  target resolution (url/source-item-id/raw)
 *   13-17: credential validation (oauth/api-token shape errors)
 *   18-21: token refresh (happy + failure + callback throw + non-rotation)
 *   22-23: rate-limiting (retry once / exhausted)
 *   24:    happy path with OAuth credentials
 *   25:    happy path with static api-token credentials
 *   26-29: format selection priority (source > glb > gltf > usdz)
 *   30:    no formats → no-downloadable-formats
 *   31:    downloadable=false → unknown + "not downloadable"
 *   32:    license preserved verbatim
 *   33:    stream-error → partial-file unlinked + network-error
 *   34:    abort signal aborts mid-fetch
 *   35:    HTTP 404 from metadata → content-removed
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { createSketchfabAdapter } from '../../src/scavengers/adapters/sketchfab';
import type { FetchContext, FetchTarget, ScavengerEvent } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// Test fixtures + helpers
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

const TEST_API_BASE = 'https://api.test.example/v3';
const TEST_TOKEN_ENDPOINT = 'https://test.example/oauth2/token/';

const MODEL_UID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32-char hex
const MODEL_URL = `https://sketchfab.com/3d-models/cool-model-${MODEL_UID}`;

async function makeStagingDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sketchfab-test-'));
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

function makeUrlTarget(url: string): FetchTarget {
  return { kind: 'url', url };
}
function makeSourceItemIdTarget(id: string): FetchTarget {
  return { kind: 'source-item-id', sourceItemId: id };
}
function makeRawTarget(): FetchTarget {
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
    accessToken: overrides?.accessToken ?? 'access-tok-123',
    refreshToken: overrides?.refreshToken ?? 'refresh-tok-123',
    expiresAt: overrides?.expiresAt ?? Date.now() + 60 * 60 * 1000, // 1h ahead
    clientId: overrides?.clientId ?? 'client-id-x',
    clientSecret: overrides?.clientSecret ?? 'client-secret-y',
  };
}

function apiTokenCreds(token = 'static-tok-123') {
  return { kind: 'api-token' as const, token };
}

const fakeMetadata = {
  uid: MODEL_UID,
  name: 'Cool Model',
  description: 'A very cool model',
  license: { slug: 'cc-by-4.0', label: 'Creative Commons Attribution' },
  user: { displayName: 'Maker Mike', username: 'maker_mike' },
  tags: [{ name: 'sci-fi' }, { name: 'helmet' }],
  downloadable: true,
  publishedAt: '2024-01-15T10:30:00Z',
  viewerUrl: `https://sketchfab.com/3d-models/cool-model-${MODEL_UID}`,
};

const fakeDownloadAllFormats = {
  source: { url: 'https://cdn.example/source.zip', expires: 9999999999, size: 10000 },
  glb: { url: 'https://cdn.example/file.glb', expires: 9999999999, size: 5000 },
  gltf: { url: 'https://cdn.example/file.zip', expires: 9999999999, size: 6000 },
  usdz: { url: 'https://cdn.example/file.usdz', expires: 9999999999, size: 4000 },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fileResponse(content: string | Buffer = 'fake-file-content', headers: Record<string, string> = {}): Response {
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

async function collectEvents(
  adapter: ReturnType<typeof createSketchfabAdapter>,
  ctx: FetchContext,
  target: FetchTarget,
): Promise<ScavengerEvent[]> {
  const events: ScavengerEvent[] = [];
  for await (const evt of adapter.fetch(ctx, target)) events.push(evt);
  return events;
}

function makeAdapter(httpFetch: ReturnType<typeof vi.fn>, extra?: { retryBaseMs?: number; maxRetries?: number }) {
  return createSketchfabAdapter({
    httpFetch: httpFetch as unknown as typeof fetch,
    apiBase: TEST_API_BASE,
    tokenEndpoint: TEST_TOKEN_ENDPOINT,
    retryBaseMs: extra?.retryBaseMs,
    maxRetries: extra?.maxRetries,
  });
}

// ---------------------------------------------------------------------------
// 1-5: supports()
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — supports()', () => {
  const adapter = createSketchfabAdapter();

  it('test 1: returns true for sketchfab.com /3d-models/<slug>-<uid>', () => {
    expect(adapter.supports(MODEL_URL)).toBe(true);
  });

  it('test 2: returns true for www.sketchfab.com /3d-models/<slug>-<uid>', () => {
    expect(adapter.supports(`https://www.sketchfab.com/3d-models/some-slug-${MODEL_UID}`)).toBe(true);
  });

  it('test 3: returns false for other hosts', () => {
    expect(adapter.supports('https://other-site.com/3d-models/foo')).toBe(false);
    expect(adapter.supports('https://api.sketchfab.com/v3/models/foo')).toBe(false); // api host not allowlisted
  });

  it('test 4: returns false for malformed URLs and non-model paths', () => {
    expect(adapter.supports('not-a-url')).toBe(false);
    expect(adapter.supports('')).toBe(false);
    expect(adapter.supports('https://sketchfab.com/feed')).toBe(false);
    expect(adapter.supports('https://sketchfab.com/3d-models/short-slug-tooshort')).toBe(false);
  });

  it('test 5: returns true for /models/<uid> alternate form', () => {
    expect(adapter.supports(`https://sketchfab.com/models/${MODEL_UID}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6-12: target resolution
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — target resolution', () => {
  it('test 6: url target resolves uid and queries metadata endpoint', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(fileResponse('binary'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: oauthCreds() });

    await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));

    expect(httpFetch).toHaveBeenCalledWith(
      `${TEST_API_BASE}/models/${MODEL_UID}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer access-tok-123`,
        }),
      }),
    );
  });

  it('test 7: source-item-id target uses uid directly', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(fileResponse('binary'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    await collectEvents(adapter, ctx, makeSourceItemIdTarget('direct-uid-from-db'));

    expect(httpFetch).toHaveBeenCalledWith(
      `${TEST_API_BASE}/models/direct-uid-from-db`,
      expect.anything(),
    );
  });

  it('test 8: raw target → failed mentioning "url or source-item-id"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeRawTarget());
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(last.details).toMatch(/url or source-item-id/);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 9: url target without parseable uid → failed', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://sketchfab.com/3d-models/no-uid-here'),
    );
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 13-17: credential validation
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — credential validation', () => {
  it('test 13: missing credentials → auth-revoked + "missing or not an object"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: undefined });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/missing or not an object/);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 14: missing kind discriminator → auth-revoked mentioning "kind discriminator"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { accessToken: 'x', refreshToken: 'y', expiresAt: 0, clientId: 'a', clientSecret: 'b' },
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/kind discriminator/);
  });

  it('test 15: invalid kind value → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: { kind: 'cookies', token: 'x' } });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
  });

  it('test 16: oauth without accessToken → auth-revoked + "missing accessToken"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { kind: 'oauth', refreshToken: 'r', expiresAt: 1, clientId: 'c', clientSecret: 's' },
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.details).toMatch(/missing accessToken/);
  });

  it('test 17: api-token without token → auth-revoked + "missing token"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: { kind: 'api-token' } });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.details).toMatch(/missing token/);
  });
});

// ---------------------------------------------------------------------------
// 18-21: token refresh
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — OAuth token refresh', () => {
  it('test 18: near-expiry triggers refresh; onTokenRefreshed called with new bag', async () => {
    const httpFetch = vi.fn()
      // refresh-token POST
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'new-access-tok',
        refresh_token: 'new-refresh-tok',
        expires_in: 3600,
      }))
      // metadata
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      // download endpoint
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      // file
      .mockResolvedValueOnce(fileResponse('binary'));

    const onTokenRefreshed = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() + 30_000 }), // 30s ahead → refresh
      onTokenRefreshed,
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));

    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    const newBag = onTokenRefreshed.mock.calls[0]![0] as Record<string, unknown>;
    expect(newBag['kind']).toBe('oauth');
    expect(newBag['accessToken']).toBe('new-access-tok');
    expect(newBag['refreshToken']).toBe('new-refresh-tok');
    expect(typeof newBag['expiresAt']).toBe('number');
    expect((newBag['expiresAt'] as number) > Date.now()).toBe(true);

    // Token endpoint was called as a POST with form body.
    expect(httpFetch.mock.calls[0]![0]).toBe(TEST_TOKEN_ENDPOINT);
    const tokenInit = httpFetch.mock.calls[0]![1] as RequestInit;
    expect(tokenInit.method).toBe('POST');
    expect(String(tokenInit.body)).toContain('grant_type=refresh_token');
    expect(String(tokenInit.body)).toContain('refresh_token=refresh-tok-123');

    // Downstream metadata call uses NEW access token.
    const metaInit = httpFetch.mock.calls[1]![1] as RequestInit;
    expect((metaInit.headers as Record<string, string>)['Authorization']).toBe('Bearer new-access-tok');

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 19: refresh 401 → auth-required revoked + failed auth-revoked', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 401 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() - 10_000 }), // already expired
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));

    const authReq = events.find((e) => e.kind === 'auth-required');
    expect(authReq).toBeDefined();
    if (authReq?.kind !== 'auth-required') return;
    expect(authReq.reason).toBe('revoked');

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
  });

  it('test 20: onTokenRefreshed callback throwing → fetch still completes', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'new-access-tok',
        refresh_token: 'new-refresh-tok',
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(fileResponse('binary'));

    const onTokenRefreshed = vi.fn().mockRejectedValue(new Error('persist failed'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() + 30_000 }),
      onTokenRefreshed,
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));

    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 21: refresh response without rotated refresh_token keeps existing one', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'new-access-tok',
        // no refresh_token in response
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(fileResponse('binary'));

    const onTokenRefreshed = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ refreshToken: 'old-refresh', expiresAt: Date.now() + 30_000 }),
      onTokenRefreshed,
    });

    await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));

    const newBag = onTokenRefreshed.mock.calls[0]![0] as Record<string, unknown>;
    expect(newBag['refreshToken']).toBe('old-refresh');
  });
});

// ---------------------------------------------------------------------------
// 22-23: rate-limiting
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — rate-limiting', () => {
  it('test 22: 429 once then 200 → rate-limited event emitted, completes', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(rateLimitedResponse('1'))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(fileResponse('binary'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const rl = events.find((e) => e.kind === 'rate-limited');
    expect(rl).toBeDefined();

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 23: six 429s → rate-limit-exhausted', async () => {
    const httpFetch = vi.fn().mockResolvedValue(rateLimitedResponse());
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('rate-limit-exhausted');
  });
});

// ---------------------------------------------------------------------------
// 24-25: happy paths (oauth + api-token)
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — happy path', () => {
  it('test 24: OAuth credentials, no refresh needed → completed with NormalizedItem', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeDownloadAllFormats))
      .mockResolvedValueOnce(fileResponse('source-archive-bytes', { 'Content-Disposition': 'attachment; filename="cool.zip"' }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: oauthCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
    if (last?.kind !== 'completed') return;

    const item = last.item;
    expect(item.sourceId).toBe('sketchfab');
    expect(item.sourceItemId).toBe(MODEL_UID);
    expect(item.title).toBe('Cool Model');
    expect(item.creator).toBe('Maker Mike');
    expect(item.tags).toEqual(['sci-fi', 'helmet']);
    expect(item.sourceUrl).toContain(MODEL_UID);
    expect(item.files).toHaveLength(1);
    expect(item.files[0]!.suggestedName).toBe('cool.zip');
    expect(item.files[0]!.format).toBe('source'); // highest priority
    expect(item.sourcePublishedAt).toBeInstanceOf(Date);
  });

  it('test 25: static api-token credentials → Authorization: Token header used', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/file.glb' } }))
      .mockResolvedValueOnce(fileResponse('glb-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds('my-token-xyz') });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));

    const metaInit = httpFetch.mock.calls[0]![1] as RequestInit;
    expect((metaInit.headers as Record<string, string>)['Authorization']).toBe('Token my-token-xyz');

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 26-29: format selection priority
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — format priority', () => {
  it('test 26: source available → source chosen', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeDownloadAllFormats))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files[0]!.format).toBe('source');

    // Third call must be to the source.zip URL.
    expect(httpFetch.mock.calls[2]![0]).toBe('https://cdn.example/source.zip');
  });

  it('test 27: only glb + gltf + usdz → glb chosen', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({
        glb: { url: 'https://cdn.example/file.glb' },
        gltf: { url: 'https://cdn.example/file.zip' },
        usdz: { url: 'https://cdn.example/file.usdz' },
      }))
      .mockResolvedValueOnce(fileResponse('glb-content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files[0]!.format).toBe('glb');
    expect(httpFetch.mock.calls[2]![0]).toBe('https://cdn.example/file.glb');
  });

  it('test 28: only gltf + usdz → gltf chosen', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({
        gltf: { url: 'https://cdn.example/file.zip' },
        usdz: { url: 'https://cdn.example/file.usdz' },
      }))
      .mockResolvedValueOnce(fileResponse('gltf-zip'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files[0]!.format).toBe('gltf');
  });

  it('test 29: only usdz → usdz chosen', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({
        usdz: { url: 'https://cdn.example/file.usdz' },
      }))
      .mockResolvedValueOnce(fileResponse('usdz-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files[0]!.format).toBe('usdz');
  });
});

// ---------------------------------------------------------------------------
// 30-31: download endpoint edge cases
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — download edge cases', () => {
  it('test 30: download returns {} → no-downloadable-formats', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({})); // no formats

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('no-downloadable-formats');
  });

  it('test 31: metadata downloadable=false → unknown + "not downloadable"', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...fakeMetadata, downloadable: false }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(last.details).toMatch(/not downloadable/i);
    // Download endpoint must not have been called.
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 32: license preservation
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — license preservation', () => {
  it('test 32: cc-by-sa-4.0 is preserved verbatim in NormalizedItem.license', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        ...fakeMetadata,
        license: { slug: 'cc-by-sa-4.0', label: 'CC BY-SA 4.0' },
      }))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.license).toBe('cc-by-sa-4.0');
  });
});

// ---------------------------------------------------------------------------
// 33: stream error
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — stream errors', () => {
  it('test 33: download stream error mid-read → partial file unlinked + network-error', async () => {
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
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(erroringFile);

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/stream/i);

    // Staging dir should NOT contain a partial file (we unlink on error).
    const remaining = await fsp.readdir(stagingDir);
    expect(remaining).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 34: AbortSignal
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — AbortSignal', () => {
  it('test 34: pre-aborted signal → fetch fails immediately', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const httpFetch = vi.fn().mockRejectedValue(abortErr);

    const controller = new AbortController();
    controller.abort();

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds(), signal: controller.signal });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.details).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 35: HTTP 404 from metadata
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — HTTP error mapping', () => {
  it('test 35: metadata 404 → content-removed', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('content-removed');
  });

  // M5: download-endpoint 404 — metadata succeeds, but the second API call
  // (the /download endpoint) returns 404. Happens when Sketchfab purges a
  // model between metadata fetch and download.
  it('test 36: download-endpoint 404 → content-removed', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('content-removed');
  });
});

// ---------------------------------------------------------------------------
// 37-38: I1 — 5xx retry + exhaustion
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — 5xx server errors', () => {
  it('test 37: 500 once then 200 → completes after one retry', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(fileResponse('binary'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const rl = events.find((e) => e.kind === 'rate-limited');
    expect(rl).toBeDefined();
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 38: six 500s → rate-limit-exhausted with status 500 in details', async () => {
    const httpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('rate-limit-exhausted');
    expect(last.details).toMatch(/500/);
  });

  it('test 39: 503 once then 200 → completes (Service Unavailable also retried)', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(fileResponse('binary'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 40: I2 — empty Retry-After header falls back to exponential backoff
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — Retry-After parsing', () => {
  it('test 40: empty Retry-After header → exponential backoff (not 0ms)', async () => {
    // 429 with empty retry-after header, then success. The rate-limited event
    // must show a delay derived from exponential backoff (with a non-zero
    // baseMs configured), proving the empty header did NOT collapse to 0.
    const emptyRA = new Response(null, { status: 429, headers: { 'retry-after': '' } });

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(emptyRA)
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockResolvedValueOnce(fileResponse('binary'));

    const stagingDir = await makeStagingDir();
    // baseMs=100 → first attempt's exponential delay is 100ms before jitter.
    // jitter range is [(1-0.3)*100, (1+0.3)*100] = [70, 130].
    // If empty header had been parsed as "0 seconds", the jitter input would
    // be 0 and the resulting delay would be exactly 0 — assertion below
    // catches that bug.
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 100 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const rl = events.find((e) => e.kind === 'rate-limited');
    expect(rl).toBeDefined();
    if (rl?.kind !== 'rate-limited') return;
    expect(rl.retryAfterMs).toBeGreaterThan(0);
    expect(rl.retryAfterMs).toBeGreaterThanOrEqual(70);
    expect(rl.retryAfterMs).toBeLessThanOrEqual(130);

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 41: M6 — HTTP-date Retry-After is honoured
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — HTTP-date Retry-After', () => {
  it('test 41: HTTP-date Retry-After is parsed and respected', async () => {
    // Stub Date.now() to make the delta deterministic. The header points
    // 2 seconds into the future relative to the stubbed clock.
    const FAKE_NOW = new Date('2026-01-01T12:00:00.000Z').getTime();
    const httpDate = new Date(FAKE_NOW + 2_000).toUTCString();

    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(FAKE_NOW);

    try {
      const httpFetch = vi.fn()
        .mockResolvedValueOnce(rateLimitedResponse(httpDate))
        .mockResolvedValueOnce(jsonResponse(fakeMetadata))
        .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
        .mockResolvedValueOnce(fileResponse('binary'));

      const stagingDir = await makeStagingDir();
      const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
      const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

      const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
      const rl = events.find((e) => e.kind === 'rate-limited');
      expect(rl).toBeDefined();
      if (rl?.kind !== 'rate-limited') return;
      // 2000ms ± 30% jitter → [1400, 2600].
      expect(rl.retryAfterMs).toBeGreaterThanOrEqual(1400);
      expect(rl.retryAfterMs).toBeLessThanOrEqual(2600);

      const last = events[events.length - 1];
      expect(last?.kind).toBe('completed');
    } finally {
      dateSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 42-43: I3 — abort during sleep maps to network-error
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — abort during retry sleep', () => {
  it('test 42: abort fires during rate-limit sleep → failed reason=network-error', async () => {
    // 429 first, then a controller.abort() trips the sleep() in the helper.
    // The AbortError propagates to the outer catch and must map to
    // 'network-error' (per I3) rather than 'unknown'.
    const controller = new AbortController();

    const httpFetch = vi.fn()
      // First call returns 429 with a Retry-After long enough that the
      // signal will fire well before the sleep completes.
      .mockImplementationOnce(async () => rateLimitedResponse('60'))
      .mockImplementation(async () => {
        throw new Error('should not have been called — aborted before retry');
      });

    const stagingDir = await makeStagingDir();
    // baseMs irrelevant here — we use a server-mandated 60s Retry-After so
    // the helper enters a long sleep regardless of base.
    const adapter = makeAdapter(httpFetch, { maxRetries: 6 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds(), signal: controller.signal });

    // Schedule abort just after the rate-limited event has been yielded.
    setTimeout(() => controller.abort(), 10);

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/abort/i);
    // M8: outer catch populates the error field on the failed event.
    expect(last.error).toBeDefined();
  });

  it('test 43: pre-aborted signal still maps to network-error (not unknown)', async () => {
    // A pre-aborted signal causes the very first fetch to reject with
    // AbortError. That hits the helper's network-error branch directly
    // (not the outer catch) — but the test confirms the categorization.
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const httpFetch = vi.fn().mockRejectedValue(abortErr);

    const controller = new AbortController();
    controller.abort();

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds(), signal: controller.signal });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('network-error');
    expect(last.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 44: M8 — `error` field consistently populated across failure paths
// ---------------------------------------------------------------------------

describe('createSketchfabAdapter — error field on failed events', () => {
  it('test 44: token refresh fetch error populates error field', async () => {
    const refreshErr = new Error('connect ECONNREFUSED');
    const httpFetch = vi.fn().mockRejectedValueOnce(refreshErr);

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() - 1000 }), // forces refresh
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('network-error');
    expect(last.error).toBe(refreshErr);
  });

  it('test 45: download-endpoint fetch error populates error field', async () => {
    const dlErr = new Error('connection reset');
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ glb: { url: 'https://cdn.example/x.glb' } }))
      .mockRejectedValueOnce(dlErr);

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(MODEL_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('network-error');
    expect(last.error).toBe(dlErr);
  });
});
