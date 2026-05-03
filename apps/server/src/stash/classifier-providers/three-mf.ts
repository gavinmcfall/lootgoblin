/**
 * three-mf.ts — 3MF metadata provider — V2-002-T6
 *
 * 3MF is a ZIP archive. The relevant contents:
 *   - 3D/3dmodel.model — main XML with <metadata> tags
 *   - [Content_Types].xml — file type manifest
 *
 * Extracts: Title, Designer → creator, Description, LicenseTerms → license.
 * Confidence levels are high (0.9) because 3MF metadata is explicit authorship.
 *
 * If multiple 3MF files are present in the input, only the first one that
 * yields metadata is used; subsequent ones are skipped with a warn log.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { logger } from '../../logger';
import type { ClassifierProvider, ClassifierInput, PartialClassification } from '../classifier';

const THREE_MF_EXT = '.3mf';
const MODEL_PATH = '3D/3dmodel.model';

// fast-xml-parser options — extract text content from elements.
// `processEntities: false` disables XML entity expansion — billion-laughs
// defense for files from untrusted sources (downloaded stash contents). 3MF
// manifests never legitimately use entities, so this has no impact on valid
// inputs but prevents malicious 3MFs from consuming unbounded memory/CPU.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'metadata',
  processEntities: false,
});

type MetadataEntry = {
  '@_name'?: string;
  '#text'?: string;
  // fast-xml-parser may emit text as the element key when no children
  [key: string]: unknown;
};

/**
 * Parse a 3MF archive at `absolutePath` and return extracted metadata.
 * Returns null if the file cannot be parsed or contains no relevant metadata.
 */
async function extractThreeMfMetadata(
  absolutePath: string,
): Promise<Partial<{ title: string; creator: string; description: string; license: string }> | null> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await fs.readFile(absolutePath);
  } catch (err) {
    logger.warn({ path: absolutePath, err }, 'three-mf: failed to read file');
    return null;
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuffer);
  } catch (err) {
    logger.warn({ path: absolutePath, err }, 'three-mf: failed to unzip file');
    return null;
  }

  // Primary lookup: spec-standard casing "3D/3dmodel.model".
  // Fallback: case-insensitive match for non-conforming slicers that emit
  // "3d/3dmodel.model", "3D/3Dmodel.model", etc. Some real-world producers
  // (older Cura, custom exporters) don't match the spec's exact casing.
  let modelFile = zip.file(MODEL_PATH);
  if (modelFile === null) {
    const lookupName = MODEL_PATH.toLowerCase();
    const match = Object.keys(zip.files).find((name) => name.toLowerCase() === lookupName);
    modelFile = match ? zip.file(match) : null;
  }
  if (modelFile === null) {
    logger.debug({ path: absolutePath, entry: MODEL_PATH }, 'three-mf: model entry not found in zip');
    return null;
  }

  let xmlContent: string;
  try {
    xmlContent = await modelFile.async('string');
  } catch (err) {
    logger.warn({ path: absolutePath, err }, 'three-mf: failed to read model XML from zip');
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = xmlParser.parse(xmlContent) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ path: absolutePath, err }, 'three-mf: failed to parse model XML');
    return null;
  }

  // Navigate to model/metadata elements. Structure varies; walk defensively.
  const model = parsed['model'] as Record<string, unknown> | undefined;
  if (model == null) return null;

  const metadataRaw = model['metadata'];
  if (metadataRaw == null) return null;

  // fast-xml-parser wraps in array when isArray returns true.
  const metadataList: MetadataEntry[] = Array.isArray(metadataRaw)
    ? (metadataRaw as MetadataEntry[])
    : [metadataRaw as MetadataEntry];

  const result: Partial<{ title: string; creator: string; description: string; license: string }> = {};

  for (const entry of metadataList) {
    const name = (entry['@_name'] ?? '').toString().trim();
    // Text content may be under '#text' (when attributes present) or the raw value.
    const rawValue = entry['#text'] ?? entry['__text'] ?? Object.values(entry).find(
      (v) => typeof v === 'string' && v.length > 0,
    );
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!value) continue;

    switch (name.toLowerCase()) {
      case 'title':
        result.title = value;
        break;
      case 'designer':
        result.creator = value;
        break;
      case 'description':
        result.description = value;
        break;
      case 'licenseterms':
        result.license = value;
        break;
    }
  }

  const hasAny = result.title ?? result.creator ?? result.description ?? result.license;
  return hasAny != null ? result : null;
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createThreeMfProvider(): ClassifierProvider {
  return {
    name: 'three-mf',

    async classify(input: ClassifierInput): Promise<PartialClassification> {
      const threeMfFiles = input.files.filter((f) => {
        const lower = f.relativePath.toLowerCase();
        // V2-005e-T_e2: `.gcode.3mf` is slicer output (Bambu Studio plate
        // archive containing gcode), NOT a source 3MF model. The
        // slicer-output provider handles those; the 3MF metadata extraction
        // here would parse plate-specific metadata as if it were authorship,
        // muddying classification. Skip compound extensions.
        if (lower.endsWith('.gcode.3mf')) return false;
        return path.extname(lower) === THREE_MF_EXT;
      });

      if (threeMfFiles.length === 0) return {};

      let result: PartialClassification = {};
      let metadataFound = false;

      for (const file of threeMfFiles) {
        if (metadataFound) {
          logger.debug(
            { path: file.absolutePath },
            'three-mf: skipping additional 3MF file; metadata already obtained from first',
          );
          break;
        }

        const meta = await extractThreeMfMetadata(file.absolutePath);
        if (meta === null) continue;

        metadataFound = true;

        const partial: PartialClassification = {
          // primaryFormat is set whenever any 3MF is present.
          primaryFormat: { value: '3mf', confidence: 0.95 },
        };

        if (meta.title) partial.title = { value: meta.title, confidence: 0.9 };
        if (meta.creator) partial.creator = { value: meta.creator, confidence: 0.9 };
        if (meta.description) partial.description = { value: meta.description, confidence: 0.8 };
        if (meta.license) partial.license = { value: meta.license, confidence: 0.9 };

        result = partial;
      }

      // If no metadata was extracted from any 3MF but we have 3MF files, still
      // report the format.
      if (!metadataFound && threeMfFiles.length > 0) {
        result.primaryFormat = { value: '3mf', confidence: 0.95 };
      }

      return result;
    },
  };
}
