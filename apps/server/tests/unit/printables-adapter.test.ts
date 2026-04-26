/**
 * Unit tests — Printables adapter — V2-003-T6
 *
 * Tests the wiring + a representative subset of behaviors for the Printables
 * extension-mediated adapter. Shared logic (rate-limit, stream-error, etc.)
 * is covered exhaustively in extension-mediated-adapter.test.ts.
 *
 * Coverage targets:
 *   1:  supports('https://printables.com/model/123') → true
 *   2:  supports('https://www.printables.com/model/123') → true
 *   3:  supports('https://other-site.com/foo') → false
 *   4:  id === 'printables'
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

import { createPrintablesAdapter } from '../../src/scavengers/adapters/printables';
import type { ExtensionPayload } from '../../src/scavengers/adapters/extension-mediated';
import type { FetchContext, FetchTarget, ScavengerEvent } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

async function makeStagingDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-pr-test-'));
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
    sourceItemId: 'pr-456',
    sourceUrl: 'https://www.printables.com/model/456',
    title: 'Printables Model',
    description: 'A cool printable',
    creator: 'pr_creator',
    license: 'CC-BY-NC-4.0',
    tags: ['resin', 'figurine'],
    files: [
      { url: 'https://media.printables.com/file.stl', name: 'file.stl', size: 8000 },
    ],
    ...overrides,
  };
}

async function collectEvents(
  adapter: ReturnType<typeof createPrintablesAdapter>,
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

describe('createPrintablesAdapter — supports() + id', () => {
  const adapter = createPrintablesAdapter();

  it('test 1: supports https://printables.com/model/123 → true', () => {
    expect(adapter.supports('https://printables.com/model/123')).toBe(true);
  });

  it('test 2: supports https://www.printables.com/model/123 → true', () => {
    expect(adapter.supports('https://www.printables.com/model/123')).toBe(true);
  });

  it('test 3: supports https://other-site.com/foo → false', () => {
    expect(adapter.supports('https://other-site.com/foo')).toBe(false);
    expect(adapter.supports('https://makerworld.com/en/models/123')).toBe(false);
    expect(adapter.supports('')).toBe(false);
  });

  it('test 4: id === "printables"', () => {
    expect(adapter.id).toBe('printables');
  });
});

// ---------------------------------------------------------------------------
// 5: happy path — 2 files
// ---------------------------------------------------------------------------

describe('createPrintablesAdapter — happy path', () => {
  it('test 5: raw payload with 2 files → both staged + completed event', async () => {
    const payload = makeValidPayload({
      files: [
        { url: 'https://media.printables.com/body.stl', name: 'body.stl', size: 3000 },
        { url: 'https://media.printables.com/base.stl', name: 'base.stl', size: 1500 },
      ],
    });

    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFileResponse('body stl bytes'))
      .mockResolvedValueOnce(makeFileResponse('base stl bytes'));

    const stagingDir = await makeStagingDir();
    const adapter = createPrintablesAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(payload));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('completed');
    if (last?.kind !== 'completed') return;

    const item = last.item;
    expect(item.sourceId).toBe('printables');
    expect(item.sourceItemId).toBe('pr-456');
    expect(item.files).toHaveLength(2);

    const names = item.files.map((f) => f.suggestedName).sort();
    expect(names).toEqual(['base.stl', 'body.stl']);

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

describe('createPrintablesAdapter — non-raw targets', () => {
  it('test 6: url target → failed (extension-mediated only)', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createPrintablesAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(
      adapter,
      ctx,
      { kind: 'url', url: 'https://printables.com/model/456' },
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
    const adapter = createPrintablesAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(
      adapter,
      ctx,
      { kind: 'source-item-id', sourceItemId: 'pr-456' },
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

describe('createPrintablesAdapter — invalid payloads', () => {
  it('test 8: payload missing title → failed', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createPrintablesAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const badPayload = {
      sourceItemId: 'pr-456',
      sourceUrl: 'https://www.printables.com/model/456',
      // title intentionally omitted
      files: [{ url: 'https://media.printables.com/file.stl', name: 'file.stl' }],
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
    const adapter = createPrintablesAdapter({ httpFetch });
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

describe('createPrintablesAdapter — HTTP 401', () => {
  it('test 10: HTTP 401 on file fetch → failed, reason=auth-revoked', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));

    const stagingDir = await makeStagingDir();
    const adapter = createPrintablesAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const events = await collectEvents(adapter, ctx, makeRawTarget(makeValidPayload()));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('auth-revoked');
    expect(last.details).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// 11-12: sourceItemId validation (per-wrapper coverage)
//
// The shared factory test exercises validation, but each wrapper's `id`
// threads through to the failure path. Per-wrapper tests guard against a
// future refactor that breaks the id wiring.
// ---------------------------------------------------------------------------

describe('createPrintablesAdapter — sourceItemId validation', () => {
  it('test 11: payload with empty sourceItemId → failed with details mentioning sourceItemId', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createPrintablesAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    const badPayload = makeValidPayload({ sourceItemId: '' });

    const events = await collectEvents(adapter, ctx, makeRawTarget(badPayload));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(last.details).toMatch(/sourceItemId/i);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('test 12: payload with sourceItemId field absent → failed with details mentioning sourceItemId', async () => {
    const httpFetch = vi.fn();
    const stagingDir = await makeStagingDir();
    const adapter = createPrintablesAdapter({ httpFetch });
    const ctx = makeCtx(stagingDir);

    // Construct a payload with sourceItemId omitted entirely — distinct from
    // the empty-string case above. Use a fresh object to avoid spreading
    // makeValidPayload (which always populates sourceItemId).
    const badPayload = {
      sourceUrl: 'https://www.printables.com/model/456',
      title: 'Some Model',
      files: [{ url: 'https://media.printables.com/file.stl', name: 'file.stl' }],
    };

    const events = await collectEvents(adapter, ctx, makeRawTarget(badPayload));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind !== 'failed') return;
    expect(last.reason).toBe('unknown');
    expect(last.details).toMatch(/sourceItemId/i);
    expect(httpFetch).not.toHaveBeenCalled();
  });
});
