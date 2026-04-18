'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSSE } from './useSSE';
import { useCallback } from 'react';

export interface Item {
  id: string;
  sourceId: string;
  sourceItemId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  contentType: string;
  sourceUrl: string;
  snapshot?: Record<string, unknown>;
  destinationId?: string;
  outputPath?: string;
  lastError?: string;
  retryCount: number;
  createdAt: string;
  completedAt?: string;
}

export function useItems() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['items'],
    queryFn: async (): Promise<{ items: Item[] }> => (await fetch('/api/v1/queue')).json(),
  });
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: ['items'] }), [qc]);
  useSSE(useCallback((ev) => { if (ev === 'item-updated') invalidate(); }, [invalidate]));
  return query;
}
