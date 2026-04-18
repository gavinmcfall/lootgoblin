import { manyfoldV0 } from './manyfold-v0';
import type { Packager } from './types';

export const packagers: Record<string, Packager> = { 'manyfold-v0': manyfoldV0 };

export function getPackager(id: string): Packager {
  const p = packagers[id];
  if (!p) throw new Error(`Unknown packager: ${id}`);
  return p;
}
