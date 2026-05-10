import { filesystemWriter } from './filesystem';
import type { DestinationWriter } from './types';
export const writers: Record<string, DestinationWriter> = { filesystem: filesystemWriter };
export function getWriter(type: string): DestinationWriter {
  const w = writers[type];
  if (!w) throw new Error(`Unknown destination type: ${type}`);
  return w;
}
