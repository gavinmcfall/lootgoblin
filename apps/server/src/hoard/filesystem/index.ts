import path from 'node:path';
import { expandTemplate, type NamingContext } from './naming';
import { atomicMoveDir } from './atomic';
import type { Destination, DestinationWriter } from '../types';

export const filesystemWriter: DestinationWriter = {
  async write(stagingDir, destination, { item, category }) {
    const ctx: NamingContext = {
      title: item.title,
      designer: item.designer.name,
      collection: item.collection?.name,
      category,
    };
    const subPath = expandTemplate(destination.config.namingTemplate, ctx);
    const outputPath = path.join(destination.config.path, subPath);
    await atomicMoveDir(stagingDir, outputPath);
    return { outputPath };
  },
};
