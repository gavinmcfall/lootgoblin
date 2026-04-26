/**
 * Unit tests — Google Drive SubscribableAdapter capability methods — V2-004 T7.
 *
 * Covers:
 *   - enumerateFolder: first-fire emits all, subsequent fire emits only
 *     new/updated, cursor stores fileId→modifiedTime snapshot
 *   - pollUrl: first-fire emits one item-discovered, 304 yields no items,
 *     If-None-Match header sent on subsequent firings
 *   - 401 → discovery-failed reason auth-revoked
 *   - missing credentials → auth-required + discovery-failed
 */

import { describe, it, expect, vi } from 'vitest';

import { createGdriveAdapter } from '../../src/scavengers/adapters/gdrive';
import type {
  DiscoveryContext,
  DiscoveryEvent,
} from '../../src/scavengers/subscribable';

function makeCtx(
  cursor?: string,
  credentials: Record<string, unknown> | null = { kind: 'api-key', apiKey: 'k' },
  signal?: AbortSignal,
): DiscoveryContext {
  const out: DiscoveryContext = { userId: 'user-1' };
  if (credentials !== null) out.credentials = credentials;
  if (cursor !== undefined) out.cursor = cursor;
  if (signal !== undefined) out.signal = signal;
  return out;
}

function makeListResponse(
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    modifiedTime?: string;
  }>,
  nextPageToken?: string,
): Response {
  const payload: Record<string, unknown> = { files };
  if (nextPageToken) payload['nextPageToken'] = nextPageToken;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFileMetaResponse(
  meta: { id: string; name: string; mimeType: string; modifiedTime?: string },
  etag?: string,
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (etag) headers['etag'] = etag;
  return new Response(JSON.stringify(meta), { status: 200, headers });
}

async function collect(iter: AsyncIterable<DiscoveryEvent>): Promise<DiscoveryEvent[]> {
  const out: DiscoveryEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('gdrive SubscribableAdapter — capabilities', () => {
  it('declares folder_watch + url_watch and implements methods', () => {
    const a = createGdriveAdapter();
    expect(a.capabilities.has('folder_watch')).toBe(true);
    expect(a.capabilities.has('url_watch')).toBe(true);
    expect(a.capabilities.has('creator')).toBe(false);
    expect(a.capabilities.has('tag')).toBe(false);
    expect(a.capabilities.has('saved_search')).toBe(false);
    expect(typeof a.enumerateFolder).toBe('function');
    expect(typeof a.pollUrl).toBe('function');
    expect(a.listCreator).toBeUndefined();
    expect(a.searchByTag).toBeUndefined();
    expect(a.search).toBeUndefined();
  });
});

describe('gdrive SubscribableAdapter — enumerateFolder', () => {
  it('first-fire — emits all non-folder, non-Google-native items + cursor with snapshot', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeListResponse([
        { id: 'f1', name: 'a.stl', mimeType: 'application/octet-stream', modifiedTime: '2026-04-01T00:00:00.000Z' },
        { id: 'f2', name: 'b.3mf', mimeType: 'application/octet-stream', modifiedTime: '2026-04-02T00:00:00.000Z' },
        // Google-native, should be skipped:
        { id: 'doc', name: 'doc', mimeType: 'application/vnd.google-apps.document' },
        // Folder, should be skipped (shallow enumeration):
        { id: 'sub', name: 'subfolder', mimeType: 'application/vnd.google-apps.folder' },
      ]),
    );
    const a = createGdriveAdapter({
      httpFetch,
      apiBase: 'https://api.test/drive/v3',
      retryBaseMs: 0,
    });
    const events = await collect(a.enumerateFolder!(makeCtx(), 'folder-1'));

    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items.map((i) => i.kind === 'item-discovered' && i.sourceItemId).sort()).toEqual(['f1', 'f2']);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
    if (last?.kind === 'discovery-completed') {
      expect(last.itemsTotal).toBe(2);
      const cursor = JSON.parse(last.cursor!);
      expect(cursor.lastSeen.f1).toBe('2026-04-01T00:00:00.000Z');
      expect(cursor.lastSeen.f2).toBe('2026-04-02T00:00:00.000Z');
    }
  });

  it('subsequent fire — emits only new/updated items', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeListResponse([
        { id: 'f1', name: 'a.stl', mimeType: 'application/octet-stream', modifiedTime: '2026-04-01T00:00:00.000Z' }, // unchanged
        { id: 'f2', name: 'b.3mf', mimeType: 'application/octet-stream', modifiedTime: '2026-04-15T00:00:00.000Z' }, // updated
        { id: 'f3', name: 'c.stl', mimeType: 'application/octet-stream', modifiedTime: '2026-04-15T00:00:00.000Z' }, // new
      ]),
    );
    const a = createGdriveAdapter({
      httpFetch,
      apiBase: 'https://api.test/drive/v3',
      retryBaseMs: 0,
    });
    const cursor = JSON.stringify({
      lastSeen: {
        f1: '2026-04-01T00:00:00.000Z',
        f2: '2026-04-02T00:00:00.000Z',
      },
    });
    const events = await collect(a.enumerateFolder!(makeCtx(cursor), 'folder-1'));

    const items = events.filter((e) => e.kind === 'item-discovered');
    // f1 unchanged → skipped. f2 updated, f3 new → emitted.
    expect(items.map((i) => i.kind === 'item-discovered' && i.sourceItemId).sort()).toEqual([
      'f2',
      'f3',
    ]);
  });

  it('429 → rate-limited then completes', async () => {
    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(makeListResponse([
        { id: 'f1', name: 'a', mimeType: 'application/octet-stream', modifiedTime: '2026-04-01T00:00:00Z' },
      ]));
    const a = createGdriveAdapter({
      httpFetch,
      apiBase: 'https://api.test/drive/v3',
      retryBaseMs: 0,
    });
    const events = await collect(a.enumerateFolder!(makeCtx(), 'folder-1'));
    expect(events.some((e) => e.kind === 'rate-limited')).toBe(true);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
  });

  it('401 → discovery-failed auth-revoked', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const a = createGdriveAdapter({
      httpFetch,
      apiBase: 'https://api.test/drive/v3',
      retryBaseMs: 0,
    });
    const events = await collect(a.enumerateFolder!(makeCtx(), 'folder-1'));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    if (last?.kind === 'discovery-failed') expect(last.reason).toBe('auth-revoked');
  });

  it('missing credentials → auth-required + discovery-failed', async () => {
    const httpFetch = vi.fn();
    const a = createGdriveAdapter({
      httpFetch,
      apiBase: 'https://api.test/drive/v3',
      retryBaseMs: 0,
    });
    const events = await collect(a.enumerateFolder!(makeCtx(undefined, null), 'folder-1'));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    const penult = events[events.length - 2];
    expect(penult?.kind).toBe('auth-required');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

describe('gdrive SubscribableAdapter — pollUrl', () => {
  it('first-fire — emits one item-discovered + cursor with etag/modifiedTime', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeFileMetaResponse(
        { id: 'file-abc', name: 'thing.stl', mimeType: 'application/octet-stream', modifiedTime: '2026-04-10T12:00:00.000Z' },
        '"etag-v1"',
      ),
    );
    const a = createGdriveAdapter({
      httpFetch,
      apiBase: 'https://api.test/drive/v3',
      retryBaseMs: 0,
    });
    const events = await collect(
      a.pollUrl!(makeCtx(), 'https://drive.google.com/file/d/file-abc/view'),
    );
    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(1);
    if (items[0]?.kind === 'item-discovered') {
      expect(items[0].sourceItemId).toBe('file-abc');
    }
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
    if (last?.kind === 'discovery-completed') {
      expect(last.itemsTotal).toBe(1);
      const cur = JSON.parse(last.cursor!);
      expect(cur.etag).toBe('"etag-v1"');
      expect(cur.modifiedTime).toBe('2026-04-10T12:00:00.000Z');
    }
  });

  it('subsequent fire — sends If-None-Match; 304 → no items, cursor preserved', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 304 }));
    const a = createGdriveAdapter({
      httpFetch,
      apiBase: 'https://api.test/drive/v3',
      retryBaseMs: 0,
    });
    const cursor = JSON.stringify({ etag: '"etag-v1"', modifiedTime: '2026-04-10T12:00:00.000Z' });
    const events = await collect(
      a.pollUrl!(makeCtx(cursor), 'https://drive.google.com/file/d/file-abc/view'),
    );

    // Verify If-None-Match was sent.
    const callOpts = httpFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = callOpts?.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"etag-v1"');

    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(0);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
    if (last?.kind === 'discovery-completed') {
      expect(last.itemsTotal).toBe(0);
      expect(JSON.parse(last.cursor!)).toEqual({ etag: '"etag-v1"', modifiedTime: '2026-04-10T12:00:00.000Z' });
    }
  });

  it('subsequent fire — modifiedTime changed → emits one item', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(
      makeFileMetaResponse(
        { id: 'file-abc', name: 'thing.stl', mimeType: 'application/octet-stream', modifiedTime: '2026-04-20T00:00:00.000Z' },
        '"etag-v2"',
      ),
    );
    const a = createGdriveAdapter({
      httpFetch,
      apiBase: 'https://api.test/drive/v3',
      retryBaseMs: 0,
    });
    const cursor = JSON.stringify({ etag: '"etag-v1"', modifiedTime: '2026-04-10T12:00:00.000Z' });
    const events = await collect(
      a.pollUrl!(makeCtx(cursor), 'https://drive.google.com/file/d/file-abc/view'),
    );
    const items = events.filter((e) => e.kind === 'item-discovered');
    expect(items).toHaveLength(1);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-completed');
  });

  it('non-file URL → discovery-failed', async () => {
    const a = createGdriveAdapter({ httpFetch: vi.fn(), retryBaseMs: 0 });
    const events = await collect(
      a.pollUrl!(makeCtx(), 'https://docs.google.com/document/d/abc/edit'),
    );
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    if (last?.kind === 'discovery-failed') expect(last.reason).toBe('no-results');
  });

  it('401 → discovery-failed auth-revoked', async () => {
    const httpFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const a = createGdriveAdapter({
      httpFetch,
      apiBase: 'https://api.test/drive/v3',
      retryBaseMs: 0,
    });
    const events = await collect(
      a.pollUrl!(makeCtx(), 'https://drive.google.com/file/d/file-abc/view'),
    );
    const last = events[events.length - 1];
    expect(last?.kind).toBe('discovery-failed');
    if (last?.kind === 'discovery-failed') expect(last.reason).toBe('auth-revoked');
  });
});
