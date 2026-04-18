import type { SourceAdapter } from './types';
import { makerworld } from './makerworld';

export const adapters: Record<string, SourceAdapter> = {
  makerworld,
};

export function getAdapter(sourceId: string): SourceAdapter {
  const a = adapters[sourceId];
  if (!a) throw new Error(`Unknown source: ${sourceId}`);
  return a;
}

export function listAdapters(): SourceAdapter[] {
  return Object.values(adapters);
}
