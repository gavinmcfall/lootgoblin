/**
 * Unit tests — Thingiverse SubscribableAdapter capability methods — V2-004 T7.
 */

import { describe, it, expect, vi } from 'vitest';

import { createThingiverseAdapter } from '../../src/scavengers/adapters/thingiverse';
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

function makeListPage(things: Array<{ id: number; name?: string; added?: string }>): Response {
  return new Response(JSON.stringify(things), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function collect(iter: AsyncIterable<DiscoveryEvent>): Promise<DiscoveryEvent[]> {
  const out: DiscoveryEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('thingiverse SubscribableAdapter — capabilities', () => {
  it('declares creator + tag + saved_search', () => {
    const a = createThingiverseAdapter();
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

describe('thingiverse SubscribableAdapter — listCreator', () => {
  it('happy path — calls /users/<u>/things, yields item-discovered + completed', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeListPage([
        { id: 1001, name: 'Thing A', added: '2026-04-01T00:00:00Z' },
        { id: 1002, name: 'Thing B' },
      ]),
    );
    const a = createThingiverseAdapter({
      httpFetch,
      apiBase: 'https://api.test',
      retryBaseMs: 0,
      discoveryPerPage: 30,
    });
    const events = await collect(a.listCreator!(makeCtx(), 'alice'));

    const url = (httpFetch.mock.calls[0]?.[0] ?? '') as string;
    expect(url).toContain('/users/alice/things');
    expect(url).toContain('per_page=30');
    expect(url).toContain('page=1');

    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(2);
    if (items[0]?.kind === 'item-discovered') expect(items[0].sourceItemId).toBe('1001');
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
    if (last?.kind === 'discovery-completed') {
      expect(last.itemsTotal).toBe(2);
      expect(JSON.parse(last.cursor!).firstSeenSourceItemId).toBe('1001');
    }
  });

  it('first-fire — caps at firstFireBackfill items', async () => {
    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeListPage(Array.from({ length: 30 }, (_, i) => ({ id: 5000 + i, name: `T${i}` }))),
      );
    const a = createThingiverseAdapter({
      httpFetch,
      apiBase: 'https://api.test',
      firstFireBackfill: 3,
      retryBaseMs: 0,
      discoveryPerPage: 30,
    });
    const events = await collect(a.listCreator!(makeCtx(), 'alice'));
    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(3);
  });

  it('subsequent fire — stops at prior cursor id', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeListPage([
        { id: 999, name: 'New' },
        { id: 100, name: 'Prev head' },
        { id: 99, name: 'Older' },
      ]),
    );
    const a = createThingiverseAdapter({
      httpFetch,
      apiBase: 'https://api.test',
      retryBaseMs: 0,
      discoveryPerPage: 30,
    });
    const cursor = JSON.stringify({ firstSeenSourceItemId: '100' });
    const events = await collect(a.listCreator!(makeCtx(cursor), 'alice'));
    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items.map((i) => i.kind === 'item-discovered' && i.sourceItemId)).toEqual(['999']);
  });

  it('429 → rate-limited then completes', async () => {
    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(makeListPage([{ id: 7 }]));
    const a = createThingiverseAdapter({
      httpFetch,
      apiBase: 'https://api.test',
      retryBaseMs: 0,
    });
    const events = await collect(a.listCreator!(makeCtx(), 'alice'));
    expect(events.some((e) => e.kind === 'rate-limited')).toBe(true);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
  });

  it('401 → discovery-failed auth-revoked', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const a = createThingiverseAdapter({
      httpFetch,
      apiBase: 'https://api.test',
      retryBaseMs: 0,
    });
    const events = await collect(a.listCreator!(makeCtx(), 'alice'));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    if (last?.kind === 'discovery-failed') expect(last.reason).toBe('auth-revoked');
  });

  it('missing credentials → discovery-failed', async () => {
    const httpFetch = vi.fn();
    const a = createThingiverseAdapter({ httpFetch, apiBase: 'https://api.test' });
    const events = await collect(a.listCreator!(makeCtx(undefined, null), 'alice'));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    if (last?.kind === 'discovery-failed') expect(last.reason).toBe('auth-revoked');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

describe('thingiverse SubscribableAdapter — searchByTag', () => {
  it('happy path — calls /things with tag param', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(makeListPage([{ id: 11 }]));
    const a = createThingiverseAdapter({
      httpFetch,
      apiBase: 'https://api.test',
      retryBaseMs: 0,
    });
    await collect(a.searchByTag!(makeCtx(), 'spaceship'));
    const url = (httpFetch.mock.calls[0]?.[0] ?? '') as string;
    expect(url).toContain('/things?');
    expect(url).toContain('tag=spaceship');
    expect(url).toContain('sort=newest');
  });
});

describe('thingiverse SubscribableAdapter — search', () => {
  it('happy path — calls /things with q param', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(makeListPage([{ id: 22 }]));
    const a = createThingiverseAdapter({
      httpFetch,
      apiBase: 'https://api.test',
      retryBaseMs: 0,
    });
    await collect(a.search!(makeCtx(), 'rocket'));
    const url = (httpFetch.mock.calls[0]?.[0] ?? '') as string;
    expect(url).toContain('q=rocket');
  });
});
