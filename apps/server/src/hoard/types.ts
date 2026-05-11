import type { FetchedItem } from '../adapters/types';
export interface StagedPayload {
  stagingDir: string;
  fileNames: string[];
}
export interface Destination {
  id: string;
  type: 'filesystem';
  config: { path: string; namingTemplate: string };
  packager: string;
}
export interface DestinationWriter {
  write(stagingDir: string, destination: Destination, ctx: { item: FetchedItem; category?: string }): Promise<{ outputPath: string }>;
}
