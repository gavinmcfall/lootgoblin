import { defineBackground } from 'wxt/utils/define-background';
import { bc } from '@/lib/browser-compat';
import { api } from '@/lib/api-client';
import type { Message, Response } from '@/types/messages';

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
        sendResponse({ ok: false, error: 'unknown message' });
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error).message });
      }
    })();
    return true; // async response
  });
});
