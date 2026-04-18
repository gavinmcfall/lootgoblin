import { defineBackground } from 'wxt/utils/define-background';
import { bc } from '@/lib/browser-compat';
import { api, apiUpload } from '@/lib/api-client';
import { Storage } from '@/lib/storage';
import type { Message, Response, UploadStatus } from '@/types/messages';

// Module-level upload state (resets on service-worker restart)
const uploadState: UploadStatus = {
  lastRunAt: null,
  pendingCount: 0,
  lastError: null,
  recentUploads: [],
};

export default defineBackground(() => {
  bc.runtime.onMessage.addListener((msg: Message, _sender: unknown, sendResponse: (r: Response) => void) => {
    (async () => {
      try {
        if (msg.type === 'queue-tag') {
          const res = await api<{ id: string; duplicate?: boolean; existingId?: string; outputPath?: string }>('/api/v1/queue', {
            method: 'POST',
            body: JSON.stringify(msg.payload),
          });
          sendResponse({ ok: true, data: res });
          return;
        }
        if (msg.type === 'share-credential') {
          const cookies = await bc.cookies.getAll({ domain: msg.payload.domain });
          const res = await api<{ id: string; label: string }>(`/api/v1/source-credentials/${msg.payload.sourceId}`, {
            method: 'POST',
            body: JSON.stringify({ cookies }),
          });
          sendResponse({ ok: true, data: res });
          return;
        }
        if (msg.type === 'upload-now') {
          await runUploadPass();
          sendResponse({ ok: true, data: uploadState });
          return;
        }
        if (msg.type === 'upload-status') {
          sendResponse({ ok: true, data: uploadState });
          return;
        }
        sendResponse({ ok: false, error: 'unknown message' });
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error).message });
      }
    })();
    return true; // async response
  });

  // Register alarm for polling. Uses chrome.alarms API (via polyfill).
  bc.alarms.create('lootgoblin-upload-poll', { periodInMinutes: 1 });
  bc.alarms.onAlarm.addListener(async (alarm: { name: string }) => {
    if (alarm.name === 'lootgoblin-upload-poll') {
      await runUploadPass().catch((err: Error) => {
        uploadState.lastError = err.message;
      });
    }
  });
});

async function runUploadPass(): Promise<void> {
  uploadState.lastRunAt = Date.now();
  uploadState.lastError = null;

  const pairing = await Storage.getPairing();
  if (!pairing) {
    uploadState.pendingCount = 0;
    return;
  }

  // Ask the server which sources have awaiting-upload items — we'll only
  // check sources we could plausibly fetch for. For v1 we just query the
  // known adapters (makerworld). Future: query /api/v1/sources to enumerate.
  const sources = ['makerworld']; // hard-coded for v1
  const allPending: Array<{ id: string; sourceItemId: string; pendingFiles: Array<{ url: string; name: string }> }> = [];
  for (const source of sources) {
    try {
      const res = await api<{ items: Array<{ id: string; sourceItemId: string; pendingFiles: Array<{ url: string; name: string }> }> }>(
        `/api/v1/items/awaiting-upload?source=${source}`,
      );
      allPending.push(...res.items);
    } catch {
      // Server unreachable or not paired; skip.
    }
  }
  uploadState.pendingCount = allPending.length;

  for (const item of allPending) {
    for (const pf of item.pendingFiles) {
      try {
        // Fetch the URL from the extension's authenticated browser context.
        // Browser already has cookies + cleared anti-bot state, so this works.
        const fileRes = await fetch(pf.url, { credentials: 'include' });
        if (!fileRes.ok) {
          throw new Error(`fetch ${pf.url} returned ${fileRes.status}`);
        }
        // For MakerWorld f3mf: the endpoint returns JSON with a signed CDN URL.
        // Detect JSON response and unwrap to get the actual file URL.
        const ct = fileRes.headers.get('content-type') ?? '';
        let fileBlob: Blob;
        if (ct.includes('application/json')) {
          const body = (await fileRes.json()) as { url?: string; name?: string };
          if (!body.url) throw new Error('JSON response missing url field');
          const cdnRes = await fetch(body.url);
          if (!cdnRes.ok) throw new Error(`CDN fetch ${body.url} returned ${cdnRes.status}`);
          fileBlob = await cdnRes.blob();
        } else {
          fileBlob = await fileRes.blob();
        }

        await apiUpload(`/api/v1/items/${item.id}/upload`, fileBlob, pf.name);
        uploadState.recentUploads.unshift({ itemId: item.id, name: pf.name, at: Date.now() });
        if (uploadState.recentUploads.length > 20) uploadState.recentUploads.length = 20;
      } catch (err) {
        uploadState.lastError = `upload ${pf.name}: ${(err as Error).message}`;
      }
    }
  }
}
