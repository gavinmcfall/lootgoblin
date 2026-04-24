/**
 * Unit tests — MakerWorld adapter — V2-003-T6
 *
 * Tests the wiring + a representative subset of behaviors for the MakerWorld
 * extension-mediated adapter. Shared logic (rate-limit, stream-error, etc.)
 * is covered exhaustively in extension-mediated-adapter.test.ts.
 *
 * Coverage targets:
 *   1:  supports('https://makerworld.com/en/models/123') → true
 *   2:  supports('https://www.makerworld.com/en/models/123') → true
 *   3:  supports('https://other-site.com/foo') → false
 *   4:  id === 'makerworld'
 *   5:  raw payload happy path: 2 files → both staged + completed
 *   6:  url target → failed (extension-mediated only)
 *   7:  source-item-id target → failed
 *   8:  missing title → failed
 *   9:  empty files array → failed
 *   10: HTTP 401 on file fetch → auth-revoked
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { createMakerWorldAdapter } from '../../src/scavengers/adapters/makerworld';
import type { ExtensionPayload } from '../../src/scavengers/adapters/extension-mediated';
import type { FetchContext, FetchTarget, ScavengerEvent } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

async function makeStagingDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-mw-test-'));
  dirsToClean.push(dir);
  return dir;
}

function makeCtx(stagingDir: string, signal?: AbortSignal): FetchContext {
  return { userId: crypto.randomUUID(), stagingDir, signal };
}

function makeRawTarget(payload: unknown): FetchTarget {
  return { kind: 'raw', payload };
}

function makeValidPayload(overrides?: Partial<ExtensionPayload>): ExtensionPayload {
  return {
    sourceItemId: 'mw-789',
    sourceUrl: 'https://makerworld.com/en/models/789',
    title: 'MakerWorld Model',
    description: 'A great model',
    creator: 'mw_creator',
    license: 'CC-BY-4.0',
    tags: ['fdm', 'tool'],
    files: [
      { url: 'https://cdn.makerworld.com/file.stl', name: 'file.stl', size: 5000 },
    ],
    ...overrides,
  };
}

async function collectEvents(
  adapter: ReturnType<typeof createMakerWorldAdapter>,
  ctx: FetchContext,
  target: FetchTarget,
): Promise<ScavengerEvent[]> {
  const events: ScavengerEvent[] = [];
  for await (const evt of adapter.fetch(ctx, target)) {
    events.push(evt);
  }
  return events;
}

function makeFileResponse(content: string | Buffer = 'stl-content'): Response {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const stream = Readable.toWeb(Readable.from([buf])) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

afterEach(async () => {
  for (const dir of dirsToClean.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 1-4: supports() + id
// ---------------------------------------------------------------------------

describe('createMakerWorldAdapter — supports() + id', () => {
  const adapter = createMakerWorldAdapter();

  it('test 1: supports https://makerworld.com/en/models/123 → true', () => {
    expect(adapter.supports('https://makerworld.com/en/models/123')).toBe(true);
  });

  it('test 2: supports https://www.makerworld.com/en/models/123 → true', () => {
    expect(adapter.supports('https://www.makerworld.com/en/models/123')).toBe(true);
  });

  it('test 3: supports https://other-site.com/foo → false', () => {
    expect(adapter.supports('https://other-site.com/foo')).toBe(false);
    expect(adapter.supports('https://printables.com/model/123')).toBe(false);
    expect(adapter.supports('')).toBe(false);
  });

  it('test 4: id === "makerworld"', () => {
    expect(adapter.id).toBe('makerworld');
  });
});

// ---------------------------------------------------------------------------
// 5: happy path — 2 files
// ---------------------------------------------------------------------------

describe('createMakerWorldAdapter — happy path', () => {
  it('test 5: raw payload with 2 files → both staged + completed event', async () => {
    const payload = makeValidPayload({
      files: [
        { url: 'https://cdn.makerworld.com/body.stl', name: 'body.stl', size: 1000 },
        { url: 'https://cdn.makerworld.com/support.stl', name: 'support.stl', size: 2000 },
      ],
    });

    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFileResponse('body stl bytes'))
      .mockResolvedValueOnce(makeFileResponse('support stl bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = createMakerWorldAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(payload));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
    if (last?.kind !== 'completed') return;

    const item = last.item;
    expect(item.sourceId).toBe('makerworld');
    expect(item.sourceItemId).toBe('mw-789');
    expect(item.files).toHaveLength(2);

    const names = item.files.map((f) => f.suggestedName).sort();
    expect(names).toEqual(['body.stl', 'support.stl']);

    for (const file of item.files) {
      const stat = await fsp.stat(file.stagedPath);
      expect(stat.isFile()).toBe(true);
      expect(file.size).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 6-7: non-raw targets → failed
// ---------------------------------------------------------------------------

describe('createMakerWorldAdapter — non-raw targets', () => {
  it('test 6: url target → failed (extension-mediated only)', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createMakerWorldAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(
      adapter,
      ctx,
      { kind: 'url', url: 'https://makerworld.com/en/models/123' },
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(last.details).toMatch(/raw/i);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 7: source-item-id target → failed', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createMakerWorldAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(
      adapter,
      ctx,
      { kind: 'source-item-id', sourceItemId: 'mw-123' },
    );

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8-9: invalid payload shapes
// ---------------------------------------------------------------------------

describe('createMakerWorldAdapter — invalid payloads', () => {
  it('test 8: payload missing title → failed', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createMakerWorldAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const badPayload = {
      sourceItemId: 'mw-123',
      sourceUrl: 'https://makerworld.com/en/models/123',
      // title intentionally omitted
      files: [{ url: 'https://cdn.makerworld.com/file.stl', name: 'file.stl' }],
    };

    const events = await collectEvents(adapter, ctx, makeRawTarget(badPayload));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 9: empty files array → failed', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createMakerWorldAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const badPayload = makeValidPayload({ files: [] });

    const events = await collectEvents(adapter, ctx, makeRawTarget(badPayload));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10: HTTP 401 → auth-revoked
// ---------------------------------------------------------------------------

describe('createMakerWorldAdapter — HTTP 401', () => {
  it('test 10: HTTP 401 on file fetch → failed, reason=auth-revoked', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));

    const stagingDir = await makeStagingDir();
    const adapter = createMakerWorldAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/401/);
  });
});
