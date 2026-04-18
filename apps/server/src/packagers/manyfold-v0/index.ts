import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Packager } from '../types';
import type { FetchedItem } from '../../adapters/types';

export const manyfoldV0: Packager = {
  id: 'manyfold-v0',
  async package(stagingDir: string, item: FetchedItem): Promise<void> {
    const writtenResources: Array<{ name: string; path: string; mediatype: string }> = [];

    // 1. Stream files into staging
    for (const f of item.files) {
      const dest = path.join(stagingDir, f.name);
      await pipeline(f.stream, createWriteStream(dest));
      writtenResources.push({ name: path.parse(f.name).name, path: f.name, mediatype: f.mediaType });
    }

    // 2. Write datapackage.json LAST (so Manyfold never sees a half-populated folder)
    const pkg = {
      $schema: 'https://manyfold.app/profiles/0.0/datapackage.json',
      name: slug(item.title),
      title: item.title,
      homepage: item.sourceUrl,
      image: item.thumbnailUrl ? 'thumbnail.jpg' : undefined,
      keywords: item.tags,
      resources: writtenResources,
      sensitive: false,
      contributors: [{
        title: item.designer.name,
        path: item.designer.profileUrl ?? item.sourceUrl,
        roles: ['creator'],
        links: [],
      }],
      collections: item.collection
        ? [{ title: item.collection.name, path: item.collection.url ?? '', links: [] }]
        : [],
      license: { title: item.license },
      links: [],
    };
    await fs.writeFile(path.join(stagingDir, 'datapackage.json'), JSON.stringify(pkg, null, 2));
  },
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
