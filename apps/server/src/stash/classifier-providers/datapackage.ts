/**
 * datapackage.ts — datapackage.json metadata provider — V2-002-T6
 *
 * Parses Frictionless Data DataPackage spec as used by Manyfold.
 *
 * Schema excerpt:
 *   {
 *     "name": "model-name",
 *     "title": "My Cool Model",
 *     "description": "...",
 *     "licenses": [{"name": "CC-BY-4.0"}],
 *     "creators": [{"title": "Author Name"}],
 *     "keywords": ["tag1", "tag2"]
 *   }
 *
 * Confidence is high (0.85–0.95) because this is a structured, dedicated
 * metadata file — much more reliable than filename or folder heuristics.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../../logger';
import type { ClassifierProvider, ClassifierInput, PartialClassification } from '../classifier';

const DATAPACKAGE_FILENAME = 'datapackage.json';

type DatapackageJson = {
  name?: string;
  title?: string;
  description?: string;
  licenses?: Array<{ name?: string; [k: string]: unknown }>;
  creators?: Array<{ title?: string; [k: string]: unknown }>;
  keywords?: string[];
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createDatapackageProvider(): ClassifierProvider {
  return {
    name: 'datapackage',

    async classify(input: ClassifierInput): Promise<PartialClassification> {
      const dpFile = input.files.find(
        (f) => path.basename(f.relativePath).toLowerCase() === DATAPACKAGE_FILENAME,
      );

      if (dpFile == null) return {};

      let raw: string;
      try {
        raw = await fs.readFile(dpFile.absolutePath, 'utf-8');
      } catch (err) {
        logger.warn({ path: dpFile.absolutePath, err }, 'datapackage: failed to read file');
        return {};
      }

      let data: DatapackageJson;
      try {
        data = JSON.parse(raw) as DatapackageJson;
      } catch (err) {
        logger.warn({ path: dpFile.absolutePath, err }, 'datapackage: malformed JSON; skipping');
        return {};
      }

      const partial: PartialClassification = {};

      if (typeof data.title === 'string' && data.title.trim().length > 0) {
        partial.title = { value: data.title.trim(), confidence: 0.95 };
      }

      const creatorTitle = data.creators?.[0]?.title;
      if (typeof creatorTitle === 'string' && creatorTitle.trim().length > 0) {
        partial.creator = { value: creatorTitle.trim(), confidence: 0.9 };
      }

      if (typeof data.description === 'string' && data.description.trim().length > 0) {
        partial.description = { value: data.description.trim(), confidence: 0.85 };
      }

      const licenseName = data.licenses?.[0]?.name;
      if (typeof licenseName === 'string' && licenseName.trim().length > 0) {
        partial.license = { value: licenseName.trim(), confidence: 0.9 };
      }

      if (Array.isArray(data.keywords) && data.keywords.length > 0) {
        const tags = data.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean);
        if (tags.length > 0) {
          partial.tags = { value: tags, confidence: 0.85 };
        }
      }

      return partial;
    },
  };
}
