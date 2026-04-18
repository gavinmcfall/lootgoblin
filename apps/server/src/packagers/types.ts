import type { FetchedItem } from '../adapters/types';

export interface Packager {
  id: string;
  package(stagingDir: string, item: FetchedItem): Promise<void>;
}
