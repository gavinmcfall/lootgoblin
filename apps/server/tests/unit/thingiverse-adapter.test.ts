/**
 * Unit tests — Thingiverse adapter — V2-003b-T1
 *
 * Inherits the test patterns from sketchfab-adapter.test.ts (T7) and
 * gdrive-adapter.test.ts (T8). Coverage targets:
 *
 *   1-7:   supports() — host allowlist + URL shape pre-checks
 *   8-12:  target resolution (url / source-item-id / raw)
 *   13-19: credential validation (api-token / oauth / oauth+api-token)
 *   20-23: token refresh (happy + 401 + callback throw + non-rotated)
 *   24-25: rate-limiting (single retry / exhaustion)
 *   26:    happy path with API-token credentials
 *   27:    happy path with OAuth credentials
 *   28-29: dual-mode cascade (api-token → oauth on 403)
 *   30-31: multi-file Thing + filename collision dedup
 *   32-33: caps (file-count + byte cap → progress + partial completion)
 *   34-35: 404 metadata + 404 download → content-removed
 *   36-37: 5xx retry + stream error → cleanup + network-error
 *   38:    abort signal → network-error
 *   39:    license preserved verbatim
 *   40:    description passed through (no stripping)
 *   41-42: is_derivative=true + ancestors → relationships emitted
 *   43:    non-derivative → ancestors endpoint NOT called
 *   44:    raw target rejected with details mentioning url/source-item-id
 *   45:    empty files endpoint → no-downloadable-formats
 *   46:    redirect on download → followed without Authorization header
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { createThingiverseAdapter } from '../../src/scavengers/adapters/thingiverse';
import type { FetchContext, FetchTarget, ScavengerEvent } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// Test fixtures + helpers
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

const TEST_API_BASE = 'https://api.test.example';
const TEST_OAUTH_TOKEN_ENDPOINT = 'https://test.example/oauth/access_token';

const THING_ID = '1234567';
const THING_URL = `https://www.thingiverse.com/thing:${THING_ID}`;

async function makeStagingDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-thingiverse-test-'));
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
    expiresAt: overrides?.expiresAt ?? Date.now() + 60 * 60 * 1000,
    clientId: overrides?.clientId ?? 'client-id-x',
    clientSecret: overrides?.clientSecret ?? 'client-secret-y',
  };
}

function apiTokenCreds(token = 'static-tok-xyz') {
  return { kind: 'api-token' as const, token };
}

function dualCreds(opts?: { token?: string; oauth?: ReturnType<typeof oauthCreds> }) {
  const o = opts?.oauth ?? oauthCreds();
  // strip 'kind' from nested oauth bag.
  const { kind: _kind, ...rest } = o;
  return {
    kind: 'oauth+api-token' as const,
    token: opts?.token ?? 'static-tok-xyz',
    oauth: rest,
  };
}

const fakeMetadata = {
  id: 1234567,
  name: 'Cool Thing',
  description: 'A test thing description',
  license: 'Creative Commons - Attribution',
  is_derivative: false,
  public_url: `https://www.thingiverse.com/thing:${THING_ID}`,
  added: '2024-01-15T10:30:00Z',
  creator: { name: 'Maker Jane', thingiverse_username: 'maker_jane' },
  tags: [{ name: 'sci-fi' }, { name: 'helmet' }],
};

const fakeFiles = [
  { id: 100, name: 'part1.stl', size: 4096, download_url: 'https://cdn.example/file/100' },
];

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
  adapter: ReturnType<typeof createThingiverseAdapter>,
  ctx: FetchContext,
  target: FetchTarget,
): Promise<ScavengerEvent[]> {
  const events: ScavengerEvent[] = [];
  for await (const evt of adapter.fetch(ctx, target)) events.push(evt);
  return events;
}

function makeAdapter(
  httpFetch: ReturnType<typeof vi.fn>,
  extra?: { retryBaseMs?: number; maxRetries?: number; defaultCaps?: { maxFiles: number; maxBytes: number } },
) {
  return createThingiverseAdapter({
    httpFetch: httpFetch as unknown as typeof fetch,
    apiBase: TEST_API_BASE,
    oauthTokenEndpoint: TEST_OAUTH_TOKEN_ENDPOINT,
    retryBaseMs: extra?.retryBaseMs,
    maxRetries: extra?.maxRetries,
    defaultCaps: extra?.defaultCaps,
  });
}

// ---------------------------------------------------------------------------
// 1-7: supports()
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — supports()', () => {
  const adapter = createThingiverseAdapter();

  it('test 1: returns true for thingiverse.com /thing:NN', () => {
    expect(adapter.supports(`https://thingiverse.com/thing:${THING_ID}`)).toBe(true);
  });

  it('test 2: returns true for www.thingiverse.com /thing:NN', () => {
    expect(adapter.supports(THING_URL)).toBe(true);
  });

  it('test 3: returns true for /thing:NN/files', () => {
    expect(adapter.supports(`${THING_URL}/files`)).toBe(true);
  });

  it('test 4: returns true for /thing:NN/remixes', () => {
    expect(adapter.supports(`${THING_URL}/remixes`)).toBe(true);
  });

  it('test 5: returns false for other hosts', () => {
    expect(adapter.supports('https://other-site.com/thing:1234')).toBe(false);
    expect(adapter.supports('https://api.thingiverse.com/things/1234')).toBe(false);
  });

  it('test 6: returns false for /<username>/collections/<id> (not first-class Things)', () => {
    expect(
      adapter.supports('https://www.thingiverse.com/maker_jane/collections/12345'),
    ).toBe(false);
  });

  it('test 7: returns false for user profile + malformed URLs', () => {
    expect(adapter.supports('https://www.thingiverse.com/maker_jane')).toBe(false);
    expect(adapter.supports('not-a-url')).toBe(false);
    expect(adapter.supports('')).toBe(false);
    expect(adapter.supports('https://www.thingiverse.com/thing:abc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8-12: target resolution
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — target resolution', () => {
  it('test 8: url target resolves thingId and queries metadata endpoint with Bearer header', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds('the-tok') });

    await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));

    expect(httpFetch).toHaveBeenCalledWith(
      `${TEST_API_BASE}/things/${THING_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer the-tok',
        }),
      }),
    );
  });

  it('test 9: source-item-id target uses id directly', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    await collectEvents(adapter, ctx, makeSourceItemIdTarget('9999'));
    expect(httpFetch.mock.calls[0]![0]).toBe(`${TEST_API_BASE}/things/9999`);
  });

  it('test 10: raw target → failed mentioning url or source-item-id', async () => {
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

  it('test 11: url target without parseable thing → failed without HTTP call', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://www.thingiverse.com/maker_jane'),
    );
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 12: collection URL → failed without HTTP call', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://www.thingiverse.com/maker_jane/collections/55'),
    );
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 13-19: credential validation
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — credential validation', () => {
  it('test 13: missing credentials → auth-revoked + "missing or not an object"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: undefined });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/missing or not an object/);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 14: missing kind discriminator → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: { token: 'x' } });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/kind discriminator/);
  });

  it('test 15: api-token without token → auth-revoked + "missing token"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: { kind: 'api-token' } });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.details).toMatch(/missing token/);
  });

  it('test 16: oauth without accessToken → auth-revoked + "missing accessToken"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { kind: 'oauth', refreshToken: 'r', expiresAt: 1, clientId: 'c', clientSecret: 's' },
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.details).toMatch(/missing accessToken/);
  });

  it('test 17: oauth+api-token without nested oauth shape → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { kind: 'oauth+api-token', token: 'x' },
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.details).toMatch(/nested oauth shape/);
  });

  it('test 18: oauth+api-token without token sibling → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: { kind: 'oauth+api-token', oauth: oauthCreds() },
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.details).toMatch(/missing token/);
  });

  it('test 19: invalid kind value → auth-revoked', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: { kind: 'cookies', token: 'x' } });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
  });
});

// ---------------------------------------------------------------------------
// 20-23: token refresh
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — OAuth token refresh', () => {
  it('test 20: near-expiry triggers refresh; onTokenRefreshed called with new bag', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'new-access-tok',
        refresh_token: 'new-refresh-tok',
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('binary'));

    const onTokenRefreshed = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() + 30_000 }),
      onTokenRefreshed,
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));

    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    const newBag = onTokenRefreshed.mock.calls[0]![0] as Record<string, unknown>;
    expect(newBag['kind']).toBe('oauth');
    expect(newBag['accessToken']).toBe('new-access-tok');
    expect(newBag['refreshToken']).toBe('new-refresh-tok');

    expect(httpFetch.mock.calls[0]![0]).toBe(TEST_OAUTH_TOKEN_ENDPOINT);
    const tokenInit = httpFetch.mock.calls[0]![1] as RequestInit;
    expect(tokenInit.method).toBe('POST');
    expect(String(tokenInit.body)).toContain('grant_type=refresh_token');

    const metaInit = httpFetch.mock.calls[1]![1] as RequestInit;
    expect((metaInit.headers as Record<string, string>)['Authorization']).toBe('Bearer new-access-tok');

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 21: refresh 400 → auth-required revoked + failed auth-revoked', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() - 10_000 }),
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const authReq = events.find((e) => e.kind === 'auth-required');
    expect(authReq).toBeDefined();
    if (authReq?.kind !== 'auth-required') return;
    expect(authReq.reason).toBe('revoked');

    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
  });

  it('test 22: onTokenRefreshed throwing → fetch still completes', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'new-access-tok',
        refresh_token: 'new-refresh-tok',
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('binary'));

    const onTokenRefreshed = vi.fn().mockRejectedValue(new Error('persist failed'));
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() + 30_000 }),
      onTokenRefreshed,
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 23: refresh response without rotated refresh_token preserves existing one (Thingiverse historical)', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'new-access-tok',
        // no refresh_token
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('binary'));

    const onTokenRefreshed = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ refreshToken: 'old-refresh', expiresAt: Date.now() + 30_000 }),
      onTokenRefreshed,
    });

    await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const newBag = onTokenRefreshed.mock.calls[0]![0] as Record<string, unknown>;
    expect(newBag['refreshToken']).toBe('old-refresh');
  });
});

// ---------------------------------------------------------------------------
// 24-25: rate-limiting
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — rate-limiting', () => {
  it('test 24: 429 once then 200 → rate-limited event emitted, completes', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(rateLimitedResponse('1'))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('binary'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const rl = events.find((e) => e.kind === 'rate-limited');
    expect(rl).toBeDefined();

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 25: six 429s → rate-limit-exhausted', async () => {
    const httpFetch = vi.fn().mockResolvedValue(rateLimitedResponse());
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('rate-limit-exhausted');
  });
});

// ---------------------------------------------------------------------------
// 26-27: happy paths
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — happy path', () => {
  it('test 26: API-token credentials → completed with NormalizedItem (license + tags + creator)', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('part1-bytes', { 'Content-Disposition': 'attachment; filename="part1.stl"' }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds('my-tok') });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');

    const item = last.item;
    expect(item.sourceId).toBe('thingiverse');
    expect(item.sourceItemId).toBe(THING_ID);
    expect(item.title).toBe('Cool Thing');
    expect(item.creator).toBe('Maker Jane');
    expect(item.tags).toEqual(['sci-fi', 'helmet']);
    expect(item.sourceUrl).toContain(`thing:${THING_ID}`);
    expect(item.files).toHaveLength(1);
    expect(item.files[0]!.suggestedName).toBe('part1.stl');
    expect(item.sourcePublishedAt).toBeInstanceOf(Date);
  });

  it('test 27: OAuth credentials, no refresh needed → Bearer header used', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: oauthCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const metaInit = httpFetch.mock.calls[0]![1] as RequestInit;
    expect((metaInit.headers as Record<string, string>)['Authorization']).toBe('Bearer access-tok-123');

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 28-29: dual-mode cascade
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — dual-mode cascade', () => {
  it('test 28: oauth+api-token tries API token first, succeeds → no OAuth used', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: dualCreds({ token: 'app-tok' }) });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const metaInit = httpFetch.mock.calls[0]![1] as RequestInit;
    expect((metaInit.headers as Record<string, string>)['Authorization']).toBe('Bearer app-tok');

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 29: oauth+api-token — API token rejected with 403, OAuth fallback succeeds', async () => {
    const httpFetch = vi.fn()
      // 1: api-token metadata → 403
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      // 2: oauth metadata → 200
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      // 3: api-token files → 403
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      // 4: oauth files → 200
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      // 5: download
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: dualCreds({ token: 'app-tok', oauth: oauthCreds({ accessToken: 'oauth-tok' }) }),
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));

    // First call uses Bearer app-tok.
    expect((httpFetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer app-tok' });
    // Second call (oauth fallback) uses Bearer oauth-tok.
    expect((httpFetch.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer oauth-tok' });

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 30-31: multi-file + filename collision dedup
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — multi-file + dedup', () => {
  it('test 30: multiple files in one Thing → all downloaded, ordered', async () => {
    const files = [
      { id: 1, name: 'a.stl', size: 100, download_url: 'https://cdn.example/a' },
      { id: 2, name: 'b.stl', size: 200, download_url: 'https://cdn.example/b' },
      { id: 3, name: 'c.stl', size: 300, download_url: 'https://cdn.example/c' },
    ];

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(files))
      .mockResolvedValueOnce(fileResponse('a-bytes'))
      .mockResolvedValueOnce(fileResponse('b-bytes'))
      .mockResolvedValueOnce(fileResponse('c-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files.map((f) => f.suggestedName)).toEqual(['a.stl', 'b.stl', 'c.stl']);
  });

  it('test 31: filename collision dedup → README.txt + README-1.txt', async () => {
    const files = [
      { id: 1, name: 'README.txt', size: 100, download_url: 'https://cdn.example/r1' },
      { id: 2, name: 'README.txt', size: 100, download_url: 'https://cdn.example/r2' },
    ];
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(files))
      .mockResolvedValueOnce(fileResponse('first'))
      .mockResolvedValueOnce(fileResponse('second'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files.map((f) => f.suggestedName)).toEqual(['README.txt', 'README-1.txt']);
  });
});

// ---------------------------------------------------------------------------
// 32-33: caps
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — caps', () => {
  it('test 32: file-count cap exceeded → progress event + completed with partial files', async () => {
    const files = [
      { id: 1, name: 'a.stl', size: 100, download_url: 'https://cdn.example/a' },
      { id: 2, name: 'b.stl', size: 100, download_url: 'https://cdn.example/b' },
      { id: 3, name: 'c.stl', size: 100, download_url: 'https://cdn.example/c' },
      { id: 4, name: 'd.stl', size: 100, download_url: 'https://cdn.example/d' },
      { id: 5, name: 'e.stl', size: 100, download_url: 'https://cdn.example/e' },
    ];
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(files))
      .mockResolvedValueOnce(fileResponse('a'))
      .mockResolvedValueOnce(fileResponse('b'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, {
      defaultCaps: { maxFiles: 2, maxBytes: Number.MAX_SAFE_INTEGER },
    });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const capProgress = events.find(
      (e) => e.kind === 'progress' && /file-count cap/.test(e.message),
    );
    expect(capProgress).toBeDefined();

    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(2);
  });

  it('test 33: byte cap exceeded → progress event + partial completion', async () => {
    const files = [
      { id: 1, name: 'a.stl', size: 100, download_url: 'https://cdn.example/a' },
      { id: 2, name: 'b.stl', size: 999_999, download_url: 'https://cdn.example/b' }, // would push over cap
    ];
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(files))
      .mockResolvedValueOnce(fileResponse('a-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, {
      defaultCaps: { maxFiles: 100, maxBytes: 1000 },
    });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const capProgress = events.find(
      (e) => e.kind === 'progress' && /byte cap/.test(e.message),
    );
    expect(capProgress).toBeDefined();

    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 34-37: HTTP error mapping + stream
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — error mapping', () => {
  it('test 34: metadata 404 → content-removed', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('content-removed');
  });

  it('test 35: download 404 → content-removed', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('content-removed');
  });

  it('test 36: 5xx metadata + 200 retry → completes', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
  });

  it('test 37: stream error mid-download → partial unlinked + network-error', async () => {
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
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(erroringFile);

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/stream/i);

    const remaining = await fsp.readdir(stagingDir);
    expect(remaining).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 38: AbortSignal
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — AbortSignal', () => {
  it('test 38: pre-aborted signal → fetch fails immediately with network-error', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const httpFetch = vi.fn().mockRejectedValue(abortErr);

    const controller = new AbortController();
    controller.abort();

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds(), signal: controller.signal });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('network-error');
  });
});

// ---------------------------------------------------------------------------
// 39-40: license + description preservation
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — metadata preservation', () => {
  it('test 39: license preserved verbatim ("Creative Commons - Attribution-NonCommercial")', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...fakeMetadata, license: 'Creative Commons - Attribution-NonCommercial' }))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.license).toBe('Creative Commons - Attribution-NonCommercial');
  });

  it('test 40: description passed through unchanged (Thingiverse markdown-ish text)', async () => {
    const desc = 'Line 1\n\n**Bold**  +  `code`  +  https://example.com';
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...fakeMetadata, description: desc }))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.description).toBe(desc);
  });
});

// ---------------------------------------------------------------------------
// 41-43: derivative / remix relationships
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — derivative/remix metadata', () => {
  it('test 41: is_derivative=true + ancestors → relationships array populated', async () => {
    const ancestors = [
      { id: 9001, name: 'Original Thing' },
      { id: 9002, name: 'Intermediate Thing' },
    ];
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...fakeMetadata, is_derivative: true }))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'))
      .mockResolvedValueOnce(jsonResponse(ancestors));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.relationships).toEqual([
      { kind: 'remix-of', sourceId: 'thingiverse', sourceItemId: '9001', label: 'Original Thing' },
      { kind: 'remix-of', sourceId: 'thingiverse', sourceItemId: '9002', label: 'Intermediate Thing' },
    ]);
  });

  it('test 42: is_derivative=true + empty ancestors → no relationships emitted', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...fakeMetadata, is_derivative: true }))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'))
      .mockResolvedValueOnce(jsonResponse([]));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.relationships).toBeUndefined();
  });

  it('test 43: non-derivative → ancestors endpoint NOT called', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata)) // is_derivative: false
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');

    const ancestorsCall = httpFetch.mock.calls.find((c) =>
      String(c[0]).includes('/ancestors'),
    );
    expect(ancestorsCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 44-46: other edges
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — misc edges', () => {
  it('test 44: raw target rejected with details mentioning "url or source-item-id"', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeRawTarget());
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.details).toMatch(/url or source-item-id/);
  });

  it('test 45: empty files endpoint → no-downloadable-formats', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse([]));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('no-downloadable-formats');
  });

  it('test 46: redirect on download — initial hop carries Authorization, redirect target does NOT', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      // Initial download_url returns 302 → redirect
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://signed-cdn.example/redirected.bin' },
      }))
      // Redirect target returns the actual bytes
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds('app-tok-456') });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');

    // ── Initial download_url request MUST carry Authorization ────────────
    // Thingiverse's `download_url` requires the same bearer the JSON API uses
    // for non-public Things; sending no auth would 401.
    const initialDl = httpFetch.mock.calls[2]!;
    expect(initialDl[0]).toBe('https://cdn.example/file/100');
    const initialInit = initialDl[1] as RequestInit;
    const initialHeaders = (initialInit.headers ?? {}) as Record<string, string>;
    expect(initialHeaders['Authorization']).toBe('Bearer app-tok-456');

    // ── Redirect target MUST NOT carry Authorization (T7-L3) ─────────────
    const finalCall = httpFetch.mock.calls[3]!;
    expect(finalCall[0]).toBe('https://signed-cdn.example/redirected.bin');
    const finalInit = finalCall[1] as RequestInit | undefined;
    const headers = (finalInit?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 47-48: B1 — ancestors fetch graceful degradation
//
// A failed /things/:id/ancestors call MUST NOT abort an ingest whose files
// have already been staged. Spec calls relationships "data-only placeholders,
// not activated in v2" — they're a strict best-effort enrichment.
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — ancestors graceful degradation (B1)', () => {
  it('test 47: derivative Thing whose /ancestors returns 404 → completed; relationships undefined; staged file preserved', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...fakeMetadata, is_derivative: true }))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('staged-bytes'))
      // /ancestors → 404 (Thing was previously a derivative but its
      // ancestor was deleted; the endpoint can return 404 here).
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.relationships).toBeUndefined();

    // Degradation `progress` event was logged for observability.
    const degraded = events.find(
      (e) => e.kind === 'progress' && /ancestors fetch failed/.test(e.message),
    );
    expect(degraded).toBeDefined();

    // Staged file preserved on disk.
    const staged = await fsp.readdir(stagingDir);
    expect(staged.length).toBe(1);
  });

  it('test 48: derivative Thing whose /ancestors exhausts retries → completed; relationships undefined; no failed event', async () => {
    // Six 5xx responses for /ancestors → rate-limit-exhausted internally,
    // but tolerateTerminalFailure suppresses the failed yield.
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...fakeMetadata, is_derivative: true }))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('staged-bytes'))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, { maxRetries: 6, retryBaseMs: 0 });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.relationships).toBeUndefined();

    // No `failed` event polluted the stream — the ingest completes cleanly.
    const failedEvts = events.filter((e) => e.kind === 'failed');
    expect(failedEvts).toEqual([]);

    // Degradation `progress` event surfaced.
    const degraded = events.find(
      (e) => e.kind === 'progress' && /ancestors fetch failed/.test(e.message),
    );
    expect(degraded).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 49: I1 — case-insensitive URL parsing
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — case-insensitive URL parsing (I1)', () => {
  it('test 49: supports() accepts uppercase THING:NN/Files', () => {
    const adapter = createThingiverseAdapter();
    expect(adapter.supports(`https://www.thingiverse.com/THING:${THING_ID}`)).toBe(true);
    expect(adapter.supports(`https://www.thingiverse.com/THING:${THING_ID}/Files`)).toBe(true);
    expect(adapter.supports(`https://www.thingiverse.com/Thing:${THING_ID}/REMIXES`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 50: I3 — token endpoint 403 → auth-revoked (not network-error)
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — token endpoint 403 mapping (I3)', () => {
  it('test 50: refresh 403 → auth-required revoked + failed auth-revoked', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"forbidden"}', { status: 403 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() - 10_000 }),
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const authReq = events.find((e) => e.kind === 'auth-required');
    expect(authReq).toBeDefined();
    if (authReq?.kind !== 'auth-required') return;
    expect(authReq.reason).toBe('revoked');

    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/HTTP 403/);
  });
});

// ---------------------------------------------------------------------------
// 51: M2 — non-array files payload → network-error
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — non-array files payload (M2)', () => {
  it('test 51: /files returns object instead of array → failed reason network-error', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse({ error: 'unexpected shape' }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/non-array payload/);
  });
});

// ---------------------------------------------------------------------------
// 52: M5 — logger.warn observed when onTokenRefreshed callback throws
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — logger.warn observability (M5)', () => {
  it('test 52: callback throw logs a warn with the original error', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'new-access-tok',
        refresh_token: 'new-refresh-tok',
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      .mockResolvedValueOnce(fileResponse('binary'));

    // Spy on logger.warn — the adapter imports `logger` from
    // `../../logger`, so spy on the same module instance.
    const loggerModule = await import('../../src/logger');
    const warnSpy = vi.spyOn(loggerModule.logger, 'warn').mockImplementation(() => {});

    const onTokenRefreshed = vi.fn().mockRejectedValue(new Error('persist boom'));
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() + 30_000 }),
      onTokenRefreshed,
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');

    // Find the warn call mentioning the callback failure.
    const callbackWarn = warnSpy.mock.calls.find((call) =>
      String(call[1] ?? '').includes('onTokenRefreshed callback failed'),
    );
    expect(callbackWarn).toBeDefined();
    // The first arg is the bindings object including `err`.
    if (callbackWarn) {
      const bindings = callbackWarn[0] as { err?: { message?: string } };
      expect(bindings.err).toBeDefined();
      expect(String((bindings.err as Error).message)).toMatch(/persist boom/);
    }

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 53-57: M4 — additional coverage gaps
// ---------------------------------------------------------------------------

describe('createThingiverseAdapter — exactly-at-cap (M4)', () => {
  it('test 53: file count exactly equals maxFiles → completes with all files, no cap progress event', async () => {
    const files = [
      { id: 1, name: 'a.stl', size: 100, download_url: 'https://cdn.example/a' },
      { id: 2, name: 'b.stl', size: 100, download_url: 'https://cdn.example/b' },
    ];
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      .mockResolvedValueOnce(jsonResponse(files))
      .mockResolvedValueOnce(fileResponse('a-bytes'))
      .mockResolvedValueOnce(fileResponse('b-bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch, {
      defaultCaps: { maxFiles: 2, maxBytes: Number.MAX_SAFE_INTEGER },
    });
    const ctx = makeCtx({ stagingDir, credentials: apiTokenCreds() });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'completed') throw new Error('expected completed');
    expect(last.item.files).toHaveLength(2);

    // No spurious "file-count cap reached" progress event when we exactly
    // hit the cap without trying to exceed it.
    const capProgress = events.find(
      (e) => e.kind === 'progress' && /file-count cap/.test(e.message),
    );
    expect(capProgress).toBeUndefined();
  });
});

describe('createThingiverseAdapter — token endpoint variants (M4)', () => {
  it('test 54: refresh 401 → auth-required revoked + failed auth-revoked', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() - 10_000 }),
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const authReq = events.find((e) => e.kind === 'auth-required');
    expect(authReq?.kind === 'auth-required' && authReq.reason).toBe('revoked');
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('auth-revoked');
  });

  it('test 55: refresh 503 → failed network-error (not auth-revoked — transient outage)', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() - 10_000 }),
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    // No auth-required for transient 5xx — credentials still valid, server isn't.
    expect(events.find((e) => e.kind === 'auth-required')).toBeUndefined();
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/responded 503/);
  });

  it('test 56: refresh 200 with malformed JSON → failed network-error mentioning parse', async () => {
    // `new Response('not-json')` parses fine via res.json()? Actually it
    // would throw because 'not-json' is not valid JSON. Confirm.
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response('this is not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: oauthCreds({ expiresAt: Date.now() - 10_000 }),
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    if (last?.kind !== 'failed') throw new Error('expected failed');
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/parse failed/);
  });
});

describe('createThingiverseAdapter — mixed cascade (M4)', () => {
  it('test 57: dual creds — api-token succeeds for metadata, fails (403) for files; OAuth fallback completes files', async () => {
    const httpFetch = vi.fn()
      // 1: metadata via api-token → 200
      .mockResolvedValueOnce(jsonResponse(fakeMetadata))
      // 2: files via api-token → 403
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      // 3: files via OAuth fallback → 200
      .mockResolvedValueOnce(jsonResponse(fakeFiles))
      // 4: download
      .mockResolvedValueOnce(fileResponse('content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter(httpFetch);
    const ctx = makeCtx({
      stagingDir,
      credentials: dualCreds({ token: 'app-tok-mid', oauth: oauthCreds({ accessToken: 'oauth-tok-mid' }) }),
    });

    const events = await collectEvents(adapter, ctx, makeUrlTarget(THING_URL));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');

    // Call 1 (metadata) used the api-token.
    expect((httpFetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer app-tok-mid',
    });
    // Call 2 (files first attempt) used the api-token.
    expect((httpFetch.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer app-tok-mid',
    });
    // Call 3 (files cascade fallback) used the OAuth bearer.
    expect((httpFetch.mock.calls[2]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer oauth-tok-mid',
    });
  });
});
