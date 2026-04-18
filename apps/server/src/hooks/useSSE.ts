'use client';
import { useEffect } from 'react';

export function useSSE(onMessage: (event: string, data: unknown) => void) {
  useEffect(() => {
    const es = new EventSource('/api/v1/jobs/stream');
    const handler = (ev: MessageEvent) => {
      try { onMessage(ev.type, JSON.parse(ev.data)); } catch {}
    };
    es.addEventListener('item-updated', handler as EventListener);
    es.addEventListener('hello', handler as EventListener);
    return () => es.close();
  }, [onMessage]);
}
