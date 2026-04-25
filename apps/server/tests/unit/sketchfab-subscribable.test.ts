/**
 * Unit tests — Sketchfab SubscribableAdapter capability methods — V2-004 T7.
 */

import { describe, it, expect, vi } from 'vitest';

import { createSketchfabAdapter } from '../../src/scavengers/adapters/sketchfab';
import type {
  DiscoveryContext,
  DiscoveryEvent,
} from '../../src/scavengers/subscribable';

function makeCtx(
  cursor?: string,
  credentials: Record<string, unknown> | null = { kind: 'api-token', token: 'tk' },
  signal?: AbortSignal,
): DiscoveryContext {
  const out: DiscoveryContext = { userId: 'user-1' };
  if (credentials !== null) out.credentials = credentials;
  if (cursor !== undefined) out.cursor = cursor;
  if (signal !== undefined) out.signal = signal;
  return out;
}

function makeListPage(
  results: Array<{ uid: string; name?: string; publishedAt?: string }>,
  next?: string | null,
): Response {
  const payload: Record<string, unknown> = { results };
  if (next !== undefined) payload['next'] = next;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function collect(iter: AsyncIterable<DiscoveryEvent>): Promise<DiscoveryEvent[]> {
  const out: DiscoveryEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('sketchfab SubscribableAdapter — capabilities', () => {
  it('declares creator + tag + saved_search and implements methods', () => {
    const a = createSketchfabAdapter();
    expect(a.capabilities.has('creator')).toBe(true);
    expect(a.capabilities.has('tag')).toBe(true);
    expect(a.capabilities.has('saved_search')).toBe(true);
    expect(a.capabilities.has('folder_watch')).toBe(false);
    expect(a.capabilities.has('url_watch')).toBe(false);
    expect(typeof a.listCreator).toBe('function');
    expect(typeof a.searchByTag).toBe('function');
    expect(typeof a.search).toBe('function');
  });
});

describe('sketchfab SubscribableAdapter — listCreator', () => {
  it('happy path — yields item-discovered + completed with cursor', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeListPage([
        { uid: 'aaaaaaaaaaaa1', name: 'Model A', publishedAt: '2026-04-01T00:00:00Z' },
        { uid: 'bbbbbbbbbbbb2', name: 'Model B' },
      ], null),
    );
    const a = createSketchfabAdapter({
      httpFetch,
      apiBase: 'https://api.test/v3',
      retryBaseMs: 0,
    });
    const events = await collect(a.listCreator!(makeCtx(), 'someuser'));

    // First call should hit /users/<uid>/models with sort_by=-publishedAt.
    const firstCallUrl = (httpFetch.mock.calls[0]?.[0] ?? '') as string;
    expect(firstCallUrl).toContain('/users/someuser/models');
    expect(firstCallUrl).toContain('sort_by=-publishedAt');

    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(2);
    if (items[0]?.kind === 'item-discovered') {
      expect(items[0].sourceItemId).toBe('aaaaaaaaaaaa1');
    }
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
    if (last?.kind === 'discovery-completed') {
      expect(last.itemsTotal).toBe(2);
      expect(JSON.parse(last.cursor!).firstSeenSourceItemId).toBe('aaaaaaaaaaaa1');
    }
  });

  it('first-fire — caps at firstFireBackfill items', async () => {
    // Five items in one page, but cap at 2.
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeListPage(
        Array.from({ length: 5 }, (_, i) => ({ uid: `uidxxxxxxxxx${i}`, name: `M${i}` })),
        null,
      ),
    );
    const a = createSketchfabAdapter({
      httpFetch,
      apiBase: 'https://api.test/v3',
      firstFireBackfill: 2,
      retryBaseMs: 0,
    });
    const events = await collect(a.listCreator!(makeCtx(), 'u'));
    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(2);
  });

  it('subsequent fire — stops at prior firstSeenSourceItemId', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeListPage(
        [
          { uid: 'newer000000000', name: 'New' },
          { uid: 'prevhead000000', name: 'Prev head' },
          { uid: 'older000000000', name: 'Older' },
        ],
        null,
      ),
    );
    const a = createSketchfabAdapter({
      httpFetch,
      apiBase: 'https://api.test/v3',
      retryBaseMs: 0,
    });
    const cursor = JSON.stringify({ firstSeenSourceItemId: 'prevhead000000' });
    const events = await collect(a.listCreator!(makeCtx(cursor), 'u'));
    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items.map((i) => i.kind === 'item-discovered' && i.sourceItemId)).toEqual(['newer000000000']);
  });

  it('429 then 200 → rate-limited then completes', async () => {
    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(makeListPage([{ uid: 'aaaaaaaaaaaa1' }], null));
    const a = createSketchfabAdapter({
      httpFetch,
      apiBase: 'https://api.test/v3',
      retryBaseMs: 0,
    });
    const events = await collect(a.listCreator!(makeCtx(), 'u'));
    expect(events.some((e) => e.kind === 'rate-limited')).toBe(true);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
  });

  it('401 → discovery-failed reason auth-revoked', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const a = createSketchfabAdapter({
      httpFetch,
      apiBase: 'https://api.test/v3',
      retryBaseMs: 0,
    });
    const events = await collect(a.listCreator!(makeCtx(), 'u'));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    if (last?.kind === 'discovery-failed') expect(last.reason).toBe('auth-revoked');
  });

  it('missing credentials → discovery-failed (auth-revoked)', async () => {
    const httpFetch = vi.fn();
    const a = createSketchfabAdapter({
      httpFetch,
      apiBase: 'https://api.test/v3',
      retryBaseMs: 0,
    });
    const events = await collect(a.listCreator!(makeCtx(undefined, null), 'u'));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    if (last?.kind === 'discovery-failed') expect(last.reason).toBe('auth-revoked');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

describe('sketchfab SubscribableAdapter — searchByTag', () => {
  it('happy path — calls /v3/search with type=models + tags param', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(makeListPage([{ uid: 'aaaaaaaaaaaa1' }], null));
    const a = createSketchfabAdapter({
      httpFetch,
      apiBase: 'https://api.test/v3',
      retryBaseMs: 0,
    });
    await collect(a.searchByTag!(makeCtx(), 'minis'));
    const url = (httpFetch.mock.calls[0]?.[0] ?? '') as string;
    expect(url).toContain('/search');
    expect(url).toContain('tags=minis');
    expect(url).toContain('type=models');
  });
});

describe('sketchfab SubscribableAdapter — search', () => {
  it('happy path — calls /v3/search with q param', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(makeListPage([{ uid: 'aaaaaaaaaaaa1' }], null));
    const a = createSketchfabAdapter({
      httpFetch,
      apiBase: 'https://api.test/v3',
      retryBaseMs: 0,
    });
    await collect(a.search!(makeCtx(), 'dragon'));
    const url = (httpFetch.mock.calls[0]?.[0] ?? '') as string;
    expect(url).toContain('q=dragon');
  });
});
