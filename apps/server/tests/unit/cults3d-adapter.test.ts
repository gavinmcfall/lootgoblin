/**
 * Unit tests — Cults3D adapter — V2-003-T5
 *
 * Tests the cults3d adapter in isolation (no real network, no DB, no pipeline).
 * Uses the httpFetch option seam to inject mock Responses.
 *
 * Coverage targets (spec test matrix):
 *   1-4:   supports() — correct host detection
 *   5-9:   target resolution (url/source-item-id/raw)
 *   10-11: missing / malformed credentials → auth-required
 *   12-14: HTTP 401 / 403 / 500 on GraphQL
 *   15-16: rate-limit — retry once, then exhausted
 *   17-18: GraphQL errors / null creation → failed
 *   19-20: happy path (1 file, 3 files)
 *   21:    filename sanitization (path traversal)
 *   22:    download stream error
 *   23:    pre-aborted signal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { createCults3dAdapter } from '../../src/scavengers/adapters/cults3d';
import type { FetchContext, FetchTarget, ScavengerEvent } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

async function makeStagingDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-cults3d-test-'));
  dirsToClean.push(dir);
  return dir;
}

function makeCtx(
  stagingDir: string,
  credentials?: Record<string, unknown>,
  signal?: AbortSignal,
): FetchContext {
  return {
    userId: crypto.randomUUID(),
    stagingDir,
    credentials,
    signal,
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

function validCreds(overrides?: Partial<{ email: string; apiKey: string }>) {
  return {
    email: overrides?.email ?? 'user@example.com',
    apiKey: overrides?.apiKey ?? 'test-api-key-123',
  };
}

/** Collect all events from an adapter's fetch() iterable. */
async function collectEvents(
  adapter: ReturnType<typeof createCults3dAdapter>,
  ctx: FetchContext,
  target: FetchTarget,
): Promise<ScavengerEvent[]> {
  const events: ScavengerEvent[] = [];
  for await (const evt of adapter.fetch(ctx, target)) {
    events.push(evt);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Fake Cults3D creation object
// ---------------------------------------------------------------------------

const fakeCreation = {
  id: 'abc123',
  slug: 'cool-vase-123',
  name: 'Cool Vase',
  description: 'A very cool vase',
  tags: ['vase', '3d-print'],
  license: { name: 'CC-BY-4.0' },
  creator: { nick: 'maker_alice' },
  illustrations: [{ url: 'https://cults3d.com/img/vase.jpg' }],
  downloadableSets: [
    { url: 'https://files.cults3d.com/vase.stl', name: 'vase.stl', size: 12345 },
  ],
};

/**
 * Build a Response that returns a GraphQL success payload.
 */
function makeGqlResponse(creation: typeof fakeCreation | null = fakeCreation): Response {
  return new Response(JSON.stringify({ data: { creation } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a Response with GraphQL errors array.
 */
function makeGqlErrorResponse(errors: Array<{ message: string }>): Response {
  return new Response(JSON.stringify({ errors }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a file download Response with a simple body stream.
 */
function makeFileResponse(content: string | Buffer = 'fake-stl-content'): Response {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const stream = Readable.toWeb(Readable.from([buf])) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

/**
 * Build a 429 response (rate-limited).
 */
function make429Response(retryAfter?: string): Response {
  const headers: Record<string, string> = {};
  if (retryAfter) headers['retry-after'] = retryAfter;
  return new Response(null, { status: 429, headers });
}

afterEach(async () => {
  for (const dir of dirsToClean.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 1-4: supports()
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — supports()', () => {
  const adapter = createCults3dAdapter();

  it('test 1: returns true for https://cults3d.com/en/3d-model/foo', () => {
    expect(adapter.supports('https://cults3d.com/en/3d-model/foo')).toBe(true);
  });

  it('test 2: returns true for https://www.cults3d.com/fr/3d-model/foo', () => {
    expect(adapter.supports('https://www.cults3d.com/fr/3d-model/foo')).toBe(true);
  });

  it('test 3: returns false for https://other-site.com/foo', () => {
    expect(adapter.supports('https://other-site.com/foo')).toBe(false);
  });

  it('test 4: returns false for malformed/non-URL strings', () => {
    expect(adapter.supports('not-a-url')).toBe(false);
    expect(adapter.supports('')).toBe(false);
    expect(adapter.supports('://bad')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5-9: target resolution
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — target resolution', () => {
  it('test 5: url target with /en/3d-model/{slug} posts correct slug in GraphQL variables', async () => {
    const httpFetch = vi.fn();
    // First call: GraphQL, second call: file download
    httpFetch
      .mockResolvedValueOnce(makeGqlResponse())
      .mockResolvedValueOnce(makeFileResponse());

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    await collectEvents(adapter, ctx, makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'));

    // First call must be the GraphQL POST.
    expect(httpFetch).toHaveBeenCalledWith(
      'https://test.example/graphql',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"slug":"cool-vase-123"'),
      }),
    );
  });

  it('test 6: url target with locale /fr/3d-model/{slug} extracts slug correctly', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(makeGqlResponse())
      .mockResolvedValueOnce(makeFileResponse());

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/fr/3d-model/cool-vase-123'),
    );

    expect(httpFetch).toHaveBeenCalledWith(
      'https://test.example/graphql',
      expect.objectContaining({
        body: expect.stringContaining('"slug":"cool-vase-123"'),
      }),
    );
  });

  it('test 7: url target without /3d-model/ path → failed with unknown', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/collections/popular'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(last.details).toMatch(/3d-model/);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 8: source-item-id target uses id directly as slug in GraphQL body', async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(makeGqlResponse())
      .mockResolvedValueOnce(makeFileResponse());

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    await collectEvents(adapter, ctx, makeSourceItemIdTarget('my-slug-from-db'));

    expect(httpFetch).toHaveBeenCalledWith(
      'https://test.example/graphql',
      expect.objectContaining({
        body: expect.stringContaining('"slug":"my-slug-from-db"'),
      }),
    );
  });

  it('test 9: raw target → failed immediately', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(adapter, ctx, makeRawTarget());

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10-11: credential validation
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — credentials', () => {
  it('test 10: missing credentials → auth-required (reason=missing) followed by terminal failed (auth-revoked)', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch });
    // No credentials in ctx.
    const ctx = makeCtx(stagingDir, undefined);

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/my-model'),
    );

    // T7-CF-1: protocol invariant requires a terminal completed/failed event
    // after every non-terminal auth-required.
    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');

    // Penultimate event surfaces the auth-required hint to the UI.
    const penultimate = events[events.length - 2];
    expect(penultimate?.kind).toBe('auth-required');
    if (penultimate?.kind !== 'auth-required') return;
    expect(penultimate.reason).toBe('missing');
    expect(penultimate.surfaceToUser).toMatch(/Settings > Sources/);

    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 11: malformed credentials (no apiKey) → auth-required (reason=missing) followed by terminal failed', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir, { email: 'user@example.com' }); // no apiKey

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/my-model'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');

    const penultimate = events[events.length - 2];
    expect(penultimate?.kind).toBe('auth-required');
    if (penultimate?.kind !== 'auth-required') return;
    expect(penultimate.reason).toBe('missing');

    expect(httpFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 12-14: HTTP error codes on GraphQL
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — HTTP errors on GraphQL', () => {
  it('test 12: HTTP 401 on GraphQL → auth-required (reason=revoked) followed by terminal failed (auth-revoked)', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/model'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/401/);

    const penultimate = events[events.length - 2];
    expect(penultimate?.kind).toBe('auth-required');
    if (penultimate?.kind !== 'auth-required') return;
    expect(penultimate.reason).toBe('revoked');
    expect(penultimate.surfaceToUser).toMatch(/401/);
  });

  it('test 13: HTTP 403 on GraphQL → auth-required (reason=revoked) followed by terminal failed (auth-revoked)', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 }));
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/model'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/403/);

    const penultimate = events[events.length - 2];
    expect(penultimate?.kind).toBe('auth-required');
    if (penultimate?.kind !== 'auth-required') return;
    expect(penultimate.reason).toBe('revoked');
    expect(penultimate.surfaceToUser).toMatch(/403/);
  });

  it('test 14: HTTP 500 on GraphQL → failed, reason=network-error', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 }));
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/model'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/500/);
  });
});

// ---------------------------------------------------------------------------
// 15-16: rate-limiting
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — rate-limiting', () => {
  it(
    'test 15: HTTP 429 once then 200 → rate-limited event emitted, retry succeeds, completed yielded',
    async () => {
      const httpFetch = vi
        .fn()
        // First call: GraphQL → 429
        .mockResolvedValueOnce(make429Response('1'))
        // Second call: GraphQL → 200 + creation
        .mockResolvedValueOnce(makeGqlResponse())
        // Third call: file download
        .mockResolvedValueOnce(makeFileResponse());

      const stagingDir = await makeStagingDir();
      const adapter = createCults3dAdapter({
        httpFetch,
        endpoint: 'https://test.example/graphql',
        maxRetries: 6,
        retryBaseMs: 0, // No real sleep delay in tests.
      });
      const ctx = makeCtx(stagingDir, validCreds());

      const events = await collectEvents(
        adapter,
        ctx,
        makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
      );

      const rateLimitedEvent = events.find((e) => e.kind === 'rate-limited');
      expect(rateLimitedEvent).toBeDefined();
      if (rateLimitedEvent?.kind !== 'rate-limited') return;
      expect(rateLimitedEvent.attempt).toBe(1);
      // retryAfterMs should be ~1000ms (parsed from '1' seconds) with jitter applied
      expect(rateLimitedEvent.retryAfterMs).toBeGreaterThanOrEqual(0);
      expect(rateLimitedEvent.retryAfterMs).toBeLessThanOrEqual(60_000);

      const last = events[events.length - 1];
      expect(last?.kind).toBe('completed');
    },
    { timeout: 10_000 },
  );

  it(
    'test 16: HTTP 429 six times (maxRetries=6) → rate-limit-exhausted',
    async () => {
      // With maxRetries=6, attempt 6 hits the exhaustion guard (attempt >= maxAttempts).
      // Sequence: attempts 1..5 get 429 (retry), attempt 6 gets 429 → exhausted.
      // retryBaseMs=0 eliminates real sleep so the test runs in milliseconds.
      const httpFetch = vi.fn().mockResolvedValue(make429Response());

      const stagingDir = await makeStagingDir();
      const adapter = createCults3dAdapter({
        httpFetch,
        endpoint: 'https://test.example/graphql',
        maxRetries: 6,
        retryBaseMs: 0,
      });
      const ctx = makeCtx(stagingDir, validCreds());

      const events = await collectEvents(
        adapter,
        ctx,
        makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
      );

      const last = events[events.length - 1];
      expect(last?.kind).toBe('failed');
      if (last?.kind !== 'failed') return;
      expect(last.reason).toBe('rate-limit-exhausted');
    },
    { timeout: 5_000 },
  );
});

// ---------------------------------------------------------------------------
// 17-18: GraphQL response parsing
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — GraphQL response parsing', () => {
  it('test 17: GraphQL response {errors:[...]} → failed, reason=unknown', async () => {
    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(makeGqlErrorResponse([{ message: 'Field not found' }]));

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/model'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    // GraphQL application-layer errors are NOT TCP/DNS-level — types.ts reserves
    // 'network-error' for transport-level issues. T5 code-review fix 3 mapped
    // this to 'unknown' so retry policies don't treat permanent GraphQL
    // validation errors as retryable network blips.
    expect(last.reason).toBe('unknown');
    expect(last.details).toMatch(/Field not found/);
  });

  it('test 18: GraphQL {data:{creation:null}} → failed, reason=content-removed', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(makeGqlResponse(null));

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/gone-model'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('content-removed');
    expect(last.details).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// 19-20: Happy path
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — happy path', () => {
  it('test 19: 1 downloadable → file staged, completed event with correct NormalizedItem', async () => {
    const fileContent = Buffer.from('STL binary content here');
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(makeGqlResponse())
      .mockResolvedValueOnce(makeFileResponse(fileContent));

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
    if (last?.kind !== 'completed') return;

    const item = last.item;
    expect(item.sourceId).toBe('cults3d');
    expect(item.sourceItemId).toBe('abc123');
    expect(item.sourceUrl).toBe('https://cults3d.com/en/3d-model/cool-vase-123');
    expect(item.title).toBe('Cool Vase');
    expect(item.description).toBe('A very cool vase');
    expect(item.creator).toBe('maker_alice');
    expect(item.license).toBe('CC-BY-4.0');
    expect(item.tags).toEqual(['vase', '3d-print']);
    expect(item.files).toHaveLength(1);

    const file = item.files[0]!;
    expect(file.suggestedName).toBe('vase.stl');
    expect(file.stagedPath).toContain(stagingDir);
    expect(file.size).toBeGreaterThan(0);

    // Verify file actually exists on disk with correct content.
    const onDisk = await fsp.readFile(file.stagedPath);
    expect(onDisk.toString()).toBe('STL binary content here');
  });

  it('test 20: multi-file download — 3 downloadables → 3 files in NormalizedItem', async () => {
    const creationWith3Files = {
      ...fakeCreation,
      downloadableSets: [
        { url: 'https://files.cults3d.com/body.stl', name: 'body.stl', size: 1000 },
        { url: 'https://files.cults3d.com/lid.stl', name: 'lid.stl', size: 2000 },
        { url: 'https://files.cults3d.com/preview.png', name: 'preview.png', size: 500 },
      ],
    };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(makeGqlResponse(creationWith3Files))
      .mockResolvedValueOnce(makeFileResponse('body stl data'))
      .mockResolvedValueOnce(makeFileResponse('lid stl data'))
      .mockResolvedValueOnce(makeFileResponse('png data'));

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
    if (last?.kind !== 'completed') return;

    expect(last.item.files).toHaveLength(3);
    const names = last.item.files.map((f) => f.suggestedName).sort();
    expect(names).toEqual(['body.stl', 'lid.stl', 'preview.png']);

    // All files should be present on disk.
    for (const file of last.item.files) {
      const stat = await fsp.stat(file.stagedPath);
      expect(stat.isFile()).toBe(true);
      expect(file.size).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 21: filename sanitization
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — filename sanitization', () => {
  it('test 21: traversal filename stripped to safe basename', async () => {
    const traversalCreation = {
      ...fakeCreation,
      downloadableSets: [
        { url: 'https://files.cults3d.com/evil.stl', name: '../../../etc/passwd.stl', size: 100 },
      ],
    };

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(makeGqlResponse(traversalCreation))
      .mockResolvedValueOnce(makeFileResponse('safe content'));

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
    if (last?.kind !== 'completed') return;

    const file = last.item.files[0]!;
    // Must NOT contain path separators or dots-only traversal.
    expect(file.suggestedName).not.toContain('/');
    expect(file.suggestedName).not.toContain('\\');
    expect(file.suggestedName).not.toContain('..');
    // Should end up as the basename of the path.
    expect(file.suggestedName).toBe('passwd.stl');

    // File must be inside stagingDir, not escaped.
    expect(file.stagedPath.startsWith(stagingDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 22: download stream error
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — stream errors', () => {
  it('test 22: download stream error mid-read → failed event with network-error', async () => {
    // Create a ReadableStream that errors after emitting one chunk.
    function makeErroringStream(): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error('network drop mid-stream'));
        },
      });
    }

    const errorResponse = new Response(makeErroringStream(), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    const httpFetch = vi.fn()
      .mockResolvedValueOnce(makeGqlResponse())
      .mockResolvedValueOnce(errorResponse);

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/stream/i);
  });
});

// ---------------------------------------------------------------------------
// 23: AbortSignal — pre-aborted
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T7-CF-1 regression — auth-required must always be followed by terminal failed
// ---------------------------------------------------------------------------

describe('createCults3dAdapter — T7-CF-1 protocol invariant', () => {
  it('GraphQL 401 → final event is failed (auth-revoked) AND auth-required precedes it', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
    );

    // Final event MUST be 'failed' with reason='auth-revoked' per types.ts
    // protocol invariant: every fetch() terminates with completed/failed.
    const last = events[events.length - 1]!;
    expect(last.kind).toBe('failed');
    if (last.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');

    // The auth-required event must precede the terminal failed in the stream.
    const authRequiredIdx = events.findIndex((e) => e.kind === 'auth-required');
    expect(authRequiredIdx).toBeGreaterThanOrEqual(0);
    expect(authRequiredIdx).toBeLessThan(events.length - 1);
  });

  it('file-download 403 → final event is failed (auth-revoked) AND auth-required precedes it', async () => {
    // GraphQL succeeds, then the file-download leg gets rejected.
    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(makeGqlResponse())
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds());

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
    );

    const last = events[events.length - 1]!;
    expect(last.kind).toBe('failed');
    if (last.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');

    const authRequiredIdx = events.findIndex((e) => e.kind === 'auth-required');
    expect(authRequiredIdx).toBeGreaterThanOrEqual(0);
    expect(authRequiredIdx).toBeLessThan(events.length - 1);
  });

  it('missing credentials → final event is failed (auth-revoked) AND auth-required (reason=missing) precedes it', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir, undefined);

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
    );

    const last = events[events.length - 1]!;
    expect(last.kind).toBe('failed');
    if (last.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');

    const authRequiredEvt = events.find((e) => e.kind === 'auth-required');
    expect(authRequiredEvt).toBeDefined();
    if (authRequiredEvt?.kind !== 'auth-required') return;
    expect(authRequiredEvt.reason).toBe('missing');
  });
});

describe('createCults3dAdapter — AbortSignal', () => {
  it('test 23: pre-aborted signal → fetch call rejects → failed event emitted', async () => {
    // httpFetch simulates what a real fetch does with a pre-aborted signal:
    // it rejects immediately with an AbortError.
    const abortErr = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });
    const httpFetch = vi.fn().mockRejectedValue(abortErr);

    const controller = new AbortController();
    controller.abort();

    const stagingDir = await makeStagingDir();
    const adapter = createCults3dAdapter({ httpFetch, endpoint: 'https://test.example/graphql' });
    const ctx = makeCtx(stagingDir, validCreds(), controller.signal);

    const events = await collectEvents(
      adapter,
      ctx,
      makeUrlTarget('https://cults3d.com/en/3d-model/cool-vase-123'),
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    // The adapter surfaces the fetch error details — should include abort info.
    expect(last.details).toBeTruthy();
  });
});
