/**
 * grouping.ts — Groups walked files into AdoptionCandidate pre-classification
 * structures (without id/classification, which the orchestrator populates).
 *
 * Heuristics (v2, kept deliberately simple):
 *
 *   1. Folder boundary: files in the same immediate parent folder are grouped
 *      as one candidate. Don't cross folder boundaries.
 *   2. Top-level files: files whose relativePath has no "/" (i.e. they live
 *      directly in the stash root) are grouped individually — each is its own
 *      candidate (or grouped by shared basename — see rule 3).
 *   3. Shared basename in same folder: files with the same stem in the same
 *      folder belong to the same candidate.
 *   4. Mixed folder: a folder with multiple distinct stems → ONE candidate per
 *      folder (the folder IS the Loot). All files attached, no stem-splitting.
 *   5. 3MF solo: a folder with exactly one .3mf file (+ optional thumbnail/
 *      readme) is ONE candidate — covered naturally by rule 4.
 */

import * as path from 'node:path';
import type { WalkedFile } from './walker';
import type { AdoptionCandidate } from '../adoption';

// ---------------------------------------------------------------------------
// Return type (no id/classification yet)
// ---------------------------------------------------------------------------

export type PreClassificationCandidate = Omit<AdoptionCandidate, 'id' | 'classification'>;

// ---------------------------------------------------------------------------
// groupFilesIntoCandidates
// ---------------------------------------------------------------------------

/**
 * Pure function — takes flat file list from walkStashRoot() and groups files
 * into pre-classification candidates.
 *
 * @param files Output from walkStashRoot().
 * @returns Pre-classification candidates (no `id` or `classification`).
 */
export function groupFilesIntoCandidates(
  files: WalkedFile[],
): PreClassificationCandidate[] {
  if (files.length === 0) return [];

  // Group files by their immediate parent folder (relative to stash root).
  // For top-level files, parentFolder is "" (empty string).
  const byFolder = new Map<string, WalkedFile[]>();

  for (const file of files) {
    const slashIdx = file.relativePath.lastIndexOf('/');
    // If no slash, file is at top level → use "" as folder key.
    const folder = slashIdx === -1 ? '' : file.relativePath.slice(0, slashIdx);
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push(file);
  }

  const candidates: PreClassificationCandidate[] = [];

  for (const [folder, folderFiles] of byFolder) {
    if (folder === '') {
      // Top-level files — group by basename stem.
      const byBasename = groupByBasename(folderFiles);
      for (const group of byBasename) {
        candidates.push({
          // For top-level files, folderRelativePath is the file's own basename
          // (the "folder" concept doesn't apply, but we use the stem as a label).
          folderRelativePath: path.basename(group[0]!.relativePath, path.extname(group[0]!.relativePath)),
          files: group,
        });
      }
    } else {
      // Files in a named folder → the whole folder is ONE candidate.
      candidates.push({
        folderRelativePath: folder,
        files: folderFiles,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Groups top-level files by their stem (filename without extension).
 * Files with the same stem are considered one candidate.
 *
 * Example: ["Dragon.stl", "Dragon.png", "Basilisk.stl"] →
 *   [["Dragon.stl","Dragon.png"], ["Basilisk.stl"]]
 */
function groupByBasename(files: WalkedFile[]): WalkedFile[][] {
  const byStem = new Map<string, WalkedFile[]>();

  for (const file of files) {
    const base = path.basename(file.relativePath);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem)!.push(file);
  }

  return Array.from(byStem.values());
}
