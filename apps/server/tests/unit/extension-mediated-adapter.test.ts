/**
 * Unit tests — extension-mediated adapter (shared logic) — V2-003-T6
 *
 * Tests behaviors that are identical regardless of source. Uses a 'makerworld'
 * sourceId + fixture hostnames to exercise the shared helper directly.
 *
 * Coverage targets:
 *   1:  429 retry succeeds → rate-limited event + completed
 *   2:  429 exhaust → rate-limit-exhausted
 *   3:  404 → content-removed
 *   4:  410 → content-removed
 *   5:  500 → network-error
 *   6:  stream error mid-download → partial file unlinked + failed
 *   7:  multi-file with duplicate sanitized name → counter suffix applied
 *   8:  pre-aborted AbortSignal → failed quickly
 *   9:  filename traversal in payload name field → sanitized
 *   10: NormalizedItem field mapping (all payload fields round-trip)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { createExtensionMediatedAdapter } from '../../src/scavengers/adapters/extension-mediated';
import type { ExtensionPayload } from '../../src/scavengers/adapters/extension-mediated';
import type { FetchContext, FetchTarget, ScavengerEvent } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

async function makeStagingDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-ext-med-test-'));
  dirsToClean.push(dir);
  return dir;
}

function makeCtx(
  stagingDir: string,
  signal?: AbortSignal,
): FetchContext {
  return {
    userId: crypto.randomUUID(),
    stagingDir,
    signal,
  };
}

function makeRawTarget(payload: unknown): FetchTarget {
  return { kind: 'raw', payload };
}

function makeValidPayload(overrides?: Partial<ExtensionPayload>): ExtensionPayload {
  return {
    sourceItemId: 'model-123',
    sourceUrl: 'https://makerworld.com/en/models/123',
    title: 'My Model',
    description: 'A test model',
    creator: 'test_creator',
    license: 'CC-BY-4.0',
    tags: ['test', 'model'],
    files: [
      { url: 'https://files.example.com/model.stl', name: 'model.stl', size: 1024 },
    ],
    ...overrides,
  };
}

/** Build a fixture adapter using 'makerworld' sourceId and a fixture host set. */
function makeAdapter(options?: Parameters<typeof createExtensionMediatedAdapter>[2]) {
  return createExtensionMediatedAdapter(
    'makerworld',
    new Set(['makerworld.com', 'www.makerworld.com']),
    options,
  );
}

/** Collect all events from an adapter's fetch() iterable. */
async function collectEvents(
  adapter: ReturnType<typeof makeAdapter>,
  ctx: FetchContext,
  target: FetchTarget,
): Promise<ScavengerEvent[]> {
  const events: ScavengerEvent[] = [];
  for await (const evt of adapter.fetch(ctx, target)) {
    events.push(evt);
  }
  return events;
}

function makeFileResponse(content: string | Buffer = 'file-content'): Response {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const stream = Readable.toWeb(Readable.from([buf])) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

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
// 1: 429 retry succeeds
// ---------------------------------------------------------------------------

describe('extension-mediated — 429 retry', () => {
  it(
    'test 1: 429 once then 200 → rate-limited event emitted, retry succeeds, completed yielded',
    async () => {
      const httpFetch = vi
        .fn()
        // First file download attempt → 429
        .mockResolvedValueOnce(make429Response('1'))
        // Retry → 200 + file body
        .mockResolvedValueOnce(makeFileResponse('stl data'));

      const stagingDir = await makeStagingDir();
      const adapter = makeAdapter({ httpFetch, maxRetries: 6, retryBaseMs: 0 });
      const ctx = makeCtx(stagingDir);

      const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

      const rateLimited = events.find((e) => e.kind === 'rate-limited');
      expect(rateLimited).toBeDefined();
      if (rateLimited?.kind !== 'rate-limited') return;
      expect(rateLimited.attempt).toBe(1);
      expect(rateLimited.retryAfterMs).toBeGreaterThanOrEqual(0);
      expect(rateLimited.retryAfterMs).toBeLessThanOrEqual(60_000);

      const last = events[events.length - 1];
      expect(last?.kind).toBe('completed');
    },
    { timeout: 10_000 },
  );
});

// ---------------------------------------------------------------------------
// 2: 429 exhaust
// ---------------------------------------------------------------------------

describe('extension-mediated — 429 exhaust', () => {
  it(
    'test 2: 429 six times (maxRetries=6) → rate-limit-exhausted',
    async () => {
      // With maxRetries=6, attempt 6 hits the exhaustion guard (attempt >= maxAttempts).
      const httpFetch = vi.fn().mockResolvedValue(make429Response());

      const stagingDir = await makeStagingDir();
      const adapter = makeAdapter({ httpFetch, maxRetries: 6, retryBaseMs: 0 });
      const ctx = makeCtx(stagingDir);

      const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

      const last = events[events.length - 1];
      expect(last?.kind).toBe('failed');
      if (last?.kind !== 'failed') return;
      expect(last.reason).toBe('rate-limit-exhausted');
    },
    { timeout: 5_000 },
  );
});

// ---------------------------------------------------------------------------
// 3: 404 → content-removed
// ---------------------------------------------------------------------------

describe('extension-mediated — 404', () => {
  it('test 3: HTTP 404 on file URL → failed, reason=content-removed', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('content-removed');
    expect(last.details).toMatch(/404/);
  });
});

// ---------------------------------------------------------------------------
// 4: 410 → content-removed
// ---------------------------------------------------------------------------

describe('extension-mediated — 410', () => {
  it('test 4: HTTP 410 on file URL → failed, reason=content-removed', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 410 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('content-removed');
    expect(last.details).toMatch(/410/);
  });
});

// ---------------------------------------------------------------------------
// 5: 500 → network-error
// ---------------------------------------------------------------------------

describe('extension-mediated — 500', () => {
  it('test 5: HTTP 500 on file URL → failed, reason=network-error', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('network-error');
    expect(last.details).toMatch(/500/);
  });
});

// ---------------------------------------------------------------------------
// 6: stream error mid-download → partial file unlinked + failed
// ---------------------------------------------------------------------------

describe('extension-mediated — stream error', () => {
  it(
    'test 6: stream error mid-download → partial file unlinked, failed with network-error',
    async () => {
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

      const httpFetch = vi.fn().mockResolvedValueOnce(errorResponse);

      const stagingDir = await makeStagingDir();
      const adapter = makeAdapter({ httpFetch });
      const ctx = makeCtx(stagingDir);

      const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

      const last = events[events.length - 1];
      expect(last?.kind).toBe('failed');
      if (last?.kind !== 'failed') return;
      expect(last.reason).toBe('network-error');
      expect(last.details).toMatch(/stream/i);

      // Verify no partial file was left behind in stagingDir.
      const remaining = await fsp.readdir(stagingDir);
      expect(remaining).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 7: duplicate sanitized name → counter suffix
// ---------------------------------------------------------------------------

describe('extension-mediated — filename dedup', () => {
  it(
    'test 7: two files that sanitize to the same name → counter suffix applied',
    async () => {
      const payload = makeValidPayload({
        files: [
          { url: 'https://files.example.com/a.stl', name: '../model.stl', size: 10 },
          { url: 'https://files.example.com/b.stl', name: './model.stl', size: 20 },
        ],
      });

      const httpFetch = vi
        .fn()
        .mockResolvedValueOnce(makeFileResponse('content-a'))
        .mockResolvedValueOnce(makeFileResponse('content-b'));

      const stagingDir = await makeStagingDir();
      const adapter = makeAdapter({ httpFetch });
      const ctx = makeCtx(stagingDir);

      const events = await collectEvents(adapter, ctx, makeRawTarget(payload));

      const last = events[events.length - 1];
      expect(last?.kind).toBe('completed');
      if (last?.kind !== 'completed') return;

      const names = last.item.files.map((f) => f.suggestedName).sort();
      // Both paths sanitize to 'model.stl' — second gets '-1' suffix.
      expect(names).toContain('model.stl');
      expect(names).toContain('model-1.stl');
      expect(names).toHaveLength(2);

      // Both files should exist on disk with distinct names.
      for (const file of last.item.files) {
        const stat = await fsp.stat(file.stagedPath);
        expect(stat.isFile()).toBe(true);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 8: pre-aborted AbortSignal
// ---------------------------------------------------------------------------

describe('extension-mediated — AbortSignal', () => {
  it('test 8: pre-aborted signal → fetch rejects → failed event emitted quickly', async () => {
    const abortErr = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });
    const httpFetch = vi.fn().mockRejectedValue(abortErr);

    const controller = new AbortController();
    controller.abort();

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir, controller.signal);

    const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.details).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 9: filename traversal sanitized
// ---------------------------------------------------------------------------

describe('extension-mediated — filename sanitization', () => {
  it('test 9: traversal filename in payload.files[].name → sanitized to safe basename', async () => {
    const payload = makeValidPayload({
      files: [
        { url: 'https://files.example.com/evil.stl', name: '../../../etc/passwd.stl', size: 100 },
      ],
    });

    const httpFetch = vi.fn().mockResolvedValueOnce(makeFileResponse('safe content'));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(payload));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
    if (last?.kind !== 'completed') return;

    const file = last.item.files[0]!;
    expect(file.suggestedName).not.toContain('/');
    expect(file.suggestedName).not.toContain('\\');
    expect(file.suggestedName).not.toContain('..');
    expect(file.suggestedName).toBe('passwd.stl');
    expect(file.stagedPath.startsWith(stagingDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10: NormalizedItem field mapping
// ---------------------------------------------------------------------------

describe('extension-mediated — NormalizedItem mapping', () => {
  it('test 10: all payload fields map correctly to NormalizedItem', async () => {
    const payload: ExtensionPayload = {
      sourceItemId: 'mw-456',
      sourceUrl: 'https://makerworld.com/en/models/456',
      title: '  Bracket v2  ',
      description: 'A mounting bracket',
      creator: 'alice_maker',
      license: 'MIT',
      tags: ['bracket', 'hardware'],
      files: [
        { url: 'https://cdn.example.com/bracket.3mf', name: 'bracket.3mf', size: 2048 },
      ],
    };

    const fileContent = Buffer.from('3mf file bytes');
    const httpFetch = vi.fn().mockResolvedValueOnce(makeFileResponse(fileContent));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(payload));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
    if (last?.kind !== 'completed') return;

    const item = last.item;
    expect(item.sourceId).toBe('makerworld');
    expect(item.sourceItemId).toBe('mw-456');
    expect(item.sourceUrl).toBe('https://makerworld.com/en/models/456');
    expect(item.title).toBe('Bracket v2'); // trimmed
    expect(item.description).toBe('A mounting bracket');
    expect(item.creator).toBe('alice_maker');
    expect(item.license).toBe('MIT');
    expect(item.tags).toEqual(['bracket', 'hardware']);
    expect(item.files).toHaveLength(1);

    const file = item.files[0]!;
    expect(file.suggestedName).toBe('bracket.3mf');
    expect(file.stagedPath).toContain(stagingDir);
    expect(file.size).toBeGreaterThan(0);

    // Verify file actually exists on disk with correct content.
    const onDisk = await fsp.readFile(file.stagedPath);
    expect(onDisk.toString()).toBe('3mf file bytes');
  });
});

// ---------------------------------------------------------------------------
// 11: HTTP 403 → auth-revoked (parallel to 10/401)
// ---------------------------------------------------------------------------

describe('extension-mediated — HTTP 403', () => {
  it('test 11: HTTP 403 on file fetch → failed, reason=auth-revoked', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 }));

    const stagingDir = await makeStagingDir();
    const adapter = makeAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/403/);
  });
});

// ---------------------------------------------------------------------------
// 12: payload with non-http(s) URL → failed before any network call
// ---------------------------------------------------------------------------

describe('extension-mediated — URL protocol guard', () => {
  it(
    'test 12: payload with javascript: URL → failed before any fetch call',
    async () => {
      const httpFetch = vi.fn();
      const stagingDir = await makeStagingDir();
      const adapter = makeAdapter({ httpFetch });
      const ctx = makeCtx(stagingDir);

      const badPayload = makeValidPayload({
        files: [
          { url: 'javascript:alert(1)', name: 'evil.stl', size: 0 },
        ],
      });

      const events = await collectEvents(adapter, ctx, makeRawTarget(badPayload));

      const last = events[events.length - 1];
      expect(last?.kind).toBe('failed');
      if (last?.kind !== 'failed') return;
      expect(last.reason).toBe('unknown');
      // Details should mention the offending URL so operators can diagnose.
      expect(last.details).toMatch(/javascript/i);
      // Critical: no network call attempted.
      expect(httpFetch).not.toHaveBeenCalled();
    },
  );

  it(
    'test 12b: payload with file:// URL → failed before any fetch call',
    async () => {
      const httpFetch = vi.fn();
      const stagingDir = await makeStagingDir();
      const adapter = makeAdapter({ httpFetch });
      const ctx = makeCtx(stagingDir);

      const badPayload = makeValidPayload({
        files: [
          { url: 'file:///etc/passwd', name: 'evil.stl', size: 0 },
        ],
      });

      const events = await collectEvents(adapter, ctx, makeRawTarget(badPayload));

      const last = events[events.length - 1];
      expect(last?.kind).toBe('failed');
      if (last?.kind !== 'failed') return;
      expect(last.reason).toBe('unknown');
      expect(last.details).toMatch(/file:/i);
      expect(httpFetch).not.toHaveBeenCalled();
    },
  );
});
