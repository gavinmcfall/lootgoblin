export type Message =
  | { type: 'queue-tag'; payload: { sourceId: string; sourceItemId: string; sourceUrl: string; contentType: string; snapshot: Record<string, unknown> } }
  | { type: 'share-credential'; payload: { sourceId: string; domain: string } }
  | { type: 'refresh-configs' }
  | { type: 'current-tab-site'; payload: { url: string } }
  | { type: 'upload-now' }
  | { type: 'upload-status' };

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface UploadStatus {
  lastRunAt: number | null;
  pendingCount: number;
  lastError: string | null;
  recentUploads: Array<{ itemId: string; name: string; at: number }>;
}
