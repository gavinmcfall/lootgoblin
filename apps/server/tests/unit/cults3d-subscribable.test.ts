/**
 * Unit tests — Cults3D SubscribableAdapter capability methods — V2-004 T7.
 *
 * Covers listCreator / searchByTag / search via the Cults3D GraphQL API,
 * exercising:
 *   - happy-path discovery yielding item-discovered + discovery-completed
 *   - first-fire backfill cap (firstFireBackfill option)
 *   - subsequent-fire stop-at-cursor behaviour
 *   - 429 rate-limit retry → completion
 *   - auth failure → discovery-failed reason='auth-revoked'
 *   - missing credentials → auth-required + discovery-failed
 */

import { describe, it, expect, vi } from 'vitest';

import { createCults3dAdapter } from '../../src/scavengers/adapters/cults3d';
import type {
  DiscoveryContext,
  DiscoveryEvent,
} from '../../src/scavengers/subscribable';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  cursor?: string,
  credentials: Record<string, unknown> | null = { email: 'u@example.com', apiKey: 'k' },
  signal?: AbortSignal,
): DiscoveryContext {
  const out: DiscoveryContext = {
    userId: 'user-1',
  };
  if (credentials !== null) out.credentials = credentials;
  if (cursor !== undefined) out.cursor = cursor;
  if (signal !== undefined) out.signal = signal;
  return out;
}

function makeCreatorPage(
  edges: Array<{ id: string; name?: string; cursor?: string; publishedAt?: string }>,
  hasNextPage = false,
  endCursor?: string,
): Response {
  const payload = {
    data: {
      creator: {
        creations: {
          edges: edges.map((e) => {
            const node: { id: string; name?: string; publishedAt?: string } = { id: e.id };
            if (e.name !== undefined) node.name = e.name;
            if (e.publishedAt !== undefined) node.publishedAt = e.publishedAt;
            return { cursor: e.cursor ?? `c-${e.id}`, node };
          }),
          pageInfo: { endCursor: endCursor ?? null, hasNextPage },
        },
      },
    },
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSearchPage(
  edges: Array<{ id: string; name?: string; cursor?: string }>,
  hasNextPage = false,
  endCursor?: string,
): Response {
  const payload = {
    data: {
      search: {
        edges: edges.map((e) => ({
          cursor: e.cursor ?? `c-${e.id}`,
          node: { id: e.id, name: e.name },
        })),
        pageInfo: { endCursor: endCursor ?? null, hasNextPage },
      },
    },
  };
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

// ---------------------------------------------------------------------------
// listCreator
// ---------------------------------------------------------------------------

describe('cults3d SubscribableAdapter — listCreator', () => {
  it('happy path — yields item-discovered events + discovery-completed with cursor', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeCreatorPage([
        { id: 'a1', name: 'Aleph', publishedAt: '2026-04-01T00:00:00Z' },
        { id: 'a2', name: 'Beta' },
      ]),
    );
    const adapter = createCults3dAdapter({
      httpFetch,
      endpoint: 'https://test.example/graphql',
      retryBaseMs: 0,
    });
    const ctx = makeCtx();

    const events = await collect(adapter.listCreator!(ctx, 'somecreator'));

    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'item-discovered', sourceItemId: 'a1' });
    if (items[0]?.kind === 'item-discovered') {
      expect(items[0].metadataHint?.title).toBe('Aleph');
      expect(items[0].metadataHint?.publishedAt).toBeInstanceOf(Date);
    }

    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
    if (last?.kind !== 'discovery-completed') return;
    expect(last.itemsTotal).toBe(2);
    expect(last.cursor).toBeDefined();
    // Cursor should encode the first-seen id from this run.
    expect(JSON.parse(last.cursor!)).toEqual({ firstSeenSourceItemId: 'a1' });
  });

  it('first-fire — caps at firstFireBackfill items', async () => {
    // Build 5 items in a single page; cap the first-fire to 2.
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeCreatorPage(
        Array.from({ length: 5 }, (_, i) => ({ id: `i${i + 1}`, name: `Item ${i + 1}` })),
      ),
    );
    const adapter = createCults3dAdapter({
      httpFetch,
      endpoint: 'https://test.example/graphql',
      firstFireBackfill: 2,
      retryBaseMs: 0,
    });
    const ctx = makeCtx(); // no cursor — first fire

    const events = await collect(adapter.listCreator!(ctx, 'creator-x'));

    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(2);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
    if (last?.kind === 'discovery-completed') expect(last.itemsTotal).toBe(2);
  });

  it('subsequent fire — stops at the prior firstSeenSourceItemId cursor', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeCreatorPage([
        { id: 'newer1', name: 'New 1' },
        { id: 'newer2', name: 'New 2' },
        { id: 'prevhead', name: 'Previously seen' },
        { id: 'older1', name: 'Older' },
      ]),
    );
    const adapter = createCults3dAdapter({
      httpFetch,
      endpoint: 'https://test.example/graphql',
      retryBaseMs: 0,
    });
    const cursor = JSON.stringify({ firstSeenSourceItemId: 'prevhead' });
    const ctx = makeCtx(cursor);

    const events = await collect(adapter.listCreator!(ctx, 'creator-x'));

    const items = events.filter((e) => e.kind === 'item-discovered');
    // Should yield only items BEFORE the cursor id.
    expect(items.map((i) => i.kind === 'item-discovered' && i.sourceItemId)).toEqual([
      'newer1',
      'newer2',
    ]);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
    if (last?.kind === 'discovery-completed') {
      expect(last.itemsTotal).toBe(2);
      expect(JSON.parse(last.cursor!)).toEqual({ firstSeenSourceItemId: 'newer1' });
    }
  });

  it('subsequent fire — no new items preserves the prior cursor', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeCreatorPage([{ id: 'prevhead', name: 'Previously seen' }]),
    );
    const adapter = createCults3dAdapter({
      httpFetch,
      endpoint: 'https://test.example/graphql',
      retryBaseMs: 0,
    });
    const cursor = JSON.stringify({ firstSeenSourceItemId: 'prevhead' });
    const ctx = makeCtx(cursor);

    const events = await collect(adapter.listCreator!(ctx, 'creator-x'));
    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(0);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
    if (last?.kind === 'discovery-completed') {
      expect(last.itemsTotal).toBe(0);
      // Prior cursor preserved.
      expect(JSON.parse(last.cursor!)).toEqual({ firstSeenSourceItemId: 'prevhead' });
    }
  });

  it('429 rate-limited then 200 → rate-limited event then completes', async () => {
    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(makeCreatorPage([{ id: 'a' }]));
    const adapter = createCults3dAdapter({
      httpFetch,
      endpoint: 'https://test.example/graphql',
      retryBaseMs: 0,
    });
    const events = await collect(adapter.listCreator!(makeCtx(), 'c'));

    expect(events.some((e) => e.kind === 'rate-limited')).toBe(true);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
  });

  it('401 → auth-required + discovery-failed reason auth-revoked', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const adapter = createCults3dAdapter({
      httpFetch,
      endpoint: 'https://test.example/graphql',
      retryBaseMs: 0,
    });
    const events = await collect(adapter.listCreator!(makeCtx(), 'c'));

    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    if (last?.kind !== 'discovery-failed') return;
    expect(last.reason).toBe('auth-revoked');

    const penultimate = events[events.length - 2];
    expect(penultimate?.kind).toBe('auth-required');
  });

  it('missing credentials → auth-required (missing) + discovery-failed (auth-revoked)', async () => {
    const httpFetch = vi.fn();
    const adapter = createCults3dAdapter({
      httpFetch,
      endpoint: 'https://test.example/graphql',
      retryBaseMs: 0,
    });
    const ctx = makeCtx(undefined, null);

    const events = await collect(adapter.listCreator!(ctx, 'c'));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    if (last?.kind === 'discovery-failed') expect(last.reason).toBe('auth-revoked');
    const penult = events[events.length - 2];
    expect(penult?.kind).toBe('auth-required');
    if (penult?.kind === 'auth-required') expect(penult.reason).toBe('missing');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// searchByTag
// ---------------------------------------------------------------------------

describe('cults3d SubscribableAdapter — searchByTag', () => {
  it('happy path — sends tag in GraphQL variables, yields item-discovered', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeSearchPage([
        { id: 't1', name: 'tagged 1' },
        { id: 't2' },
      ]),
    );
    const adapter = createCults3dAdapter({
      httpFetch,
      endpoint: 'https://test.example/graphql',
      retryBaseMs: 0,
    });
    const events = await collect(adapter.searchByTag!(makeCtx(), 'miniature'));

    expect(httpFetch).toHaveBeenCalledWith(
      'https://test.example/graphql',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"tags":["miniature"]'),
      }),
    );
    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(2);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('cults3d SubscribableAdapter — search', () => {
  it('happy path — sends query in GraphQL variables', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(makeSearchPage([{ id: 's1' }]));
    const adapter = createCults3dAdapter({
      httpFetch,
      endpoint: 'https://test.example/graphql',
      retryBaseMs: 0,
    });
    const events = await collect(adapter.search!(makeCtx(), 'dragon mini'));
    expect(httpFetch).toHaveBeenCalledWith(
      'https://test.example/graphql',
      expect.objectContaining({
        body: expect.stringContaining('"query":"dragon mini"'),
      }),
    );
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
  });
});

// ---------------------------------------------------------------------------
// capabilities declaration
// ---------------------------------------------------------------------------

describe('cults3d SubscribableAdapter — capabilities', () => {
  it('declares creator, tag, saved_search', () => {
    const adapter = createCults3dAdapter();
    expect(adapter.capabilities.has('creator')).toBe(true);
    expect(adapter.capabilities.has('tag')).toBe(true);
    expect(adapter.capabilities.has('saved_search')).toBe(true);
    expect(adapter.capabilities.has('folder_watch')).toBe(false);
    expect(adapter.capabilities.has('url_watch')).toBe(false);
  });

  it('implements the matching methods for each capability', () => {
    const adapter = createCults3dAdapter();
    expect(typeof adapter.listCreator).toBe('function');
    expect(typeof adapter.searchByTag).toBe('function');
    expect(typeof adapter.search).toBe('function');
    expect(adapter.enumerateFolder).toBeUndefined();
    expect(adapter.pollUrl).toBeUndefined();
  });
});
