export type Message =
  | { type: 'queue-tag'; payload: { sourceId: string; sourceItemId: string; sourceUrl: string; contentType: string; snapshot: Record<string, unknown> } }
  | { type: 'share-credential'; payload: { sourceId: string; domain: string } }
  | { type: 'refresh-configs' }
  | { type: 'current-tab-site'; payload: { url: string } };

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
