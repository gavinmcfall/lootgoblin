/**
 * folder-pattern.ts — Folder structure inference provider — V2-002-T6
 *
 * Infers title and creator from the folder path relative to the stash root.
 * Confidence is moderate (0.4–0.6) — better than filename heuristics but
 * still yields to structured metadata when present.
 *
 * Heuristics (applied to folderRelativePath segments):
 *   1. 2+ segments, first looks like a creator, second looks like a model name
 *      → "Creator Name/Model Name/" pattern
 *      → creator 0.6, title 0.6
 *   2. Second-to-last segment is "files" or "3d files" (case-insensitive)
 *      → "Model Name/files/" or "Model Name/3D Files/" pattern
 *      → title 0.5 from the parent segment
 *   3. Fallback: folder name itself → title 0.4
 *
 * Uses folderRelativePath from ClassifierInput. If absent, returns empty.
 */

import * as path from 'node:path';
import type { ClassifierProvider, ClassifierInput, PartialClassification } from '../classifier';

// Segments that suggest "this folder holds files, not the model itself"
const FILE_HOLDER_SEGMENTS = new Set([
  'files',
  '3d files',
  '3d',
  'stl',
  'models',
  'prints',
  'source',
  'sources',
]);

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createFolderPatternProvider(): ClassifierProvider {
  return {
    name: 'folder-pattern',

    async classify(input: ClassifierInput): Promise<PartialClassification> {
      const { folderRelativePath } = input;

      if (!folderRelativePath || folderRelativePath === '.') return {};

      // Normalise path separators and split into parts.
      const normalised = folderRelativePath
        .split(/[/\\]/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (normalised.length === 0) return {};

      // ── Heuristic 1: Creator/ModelName ─────────────────────────────────
      if (normalised.length >= 2) {
        const possibleCreator = normalised[0] ?? '';
        const possibleTitle = normalised[1] ?? '';

        // Check if second segment looks like a file-holder (disqualifies pattern 1).
        const secondLower = possibleTitle.toLowerCase();
        const isFileHolder = FILE_HOLDER_SEGMENTS.has(secondLower);

        if (!isFileHolder && possibleCreator && possibleTitle) {
          return {
            creator: { value: possibleCreator, confidence: 0.6 },
            title: { value: possibleTitle, confidence: 0.6 },
          };
        }
      }

      // ── Heuristic 2: ModelName/files ───────────────────────────────────
      const lastSegment = (normalised[normalised.length - 1] ?? '').toLowerCase();
      if (FILE_HOLDER_SEGMENTS.has(lastSegment) && normalised.length >= 2) {
        const possibleTitle = normalised[normalised.length - 2] ?? '';
        if (possibleTitle) {
          return {
            title: { value: possibleTitle, confidence: 0.5 },
          };
        }
      }

      // ── Heuristic 3: Fallback — folder name as title ──────────────────
      const folderName = path.basename(
        folderRelativePath.endsWith('/') || folderRelativePath.endsWith(path.sep)
          ? folderRelativePath.slice(0, -1)
          : folderRelativePath,
      );
      if (folderName && folderName !== '.') {
        return {
          title: { value: folderName, confidence: 0.4 },
        };
      }

      return {};
    },
  };
}
