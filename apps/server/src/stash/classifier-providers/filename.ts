/**
 * filename.ts — Filename-based heuristics provider — V2-002-T6
 *
 * Infers title and creator from file basename patterns. Confidence is
 * deliberately low (0.3–0.5) so this provider only "wins" when structured
 * metadata (3MF, datapackage.json) is absent.
 *
 * Patterns tested (case-insensitive):
 *   1. "{creator} - {title}.ext"      → creator 0.5, title 0.5
 *   2. "{title} by {creator}.ext"     → creator 0.5, title 0.5
 *   3. "{title} v{version}.ext"       → title 0.5 (version discarded)
 *   4. fallback: basename of first non-stub file → title 0.3
 *
 * "Stub files" for fallback exclusion: README*, LICENSE*, *.md, *.txt, *.pdf
 */

import * as path from 'node:path';
import type { ClassifierProvider, ClassifierInput, PartialClassification } from '../classifier';

// Files to skip for fallback basename selection.
const STUB_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.rst', '.html']);
const STUB_PREFIXES = ['readme', 'license', 'changelog', 'credits'];

function isStubFile(relativePath: string): boolean {
  const base = path.basename(relativePath).toLowerCase();
  if (STUB_EXTENSIONS.has(path.extname(base))) return true;
  if (STUB_PREFIXES.some((p) => base.startsWith(p))) return true;
  return false;
}

function stripExt(filename: string): string {
  return path.basename(filename, path.extname(filename));
}

// ---------------------------------------------------------------------------
// Pattern matchers
// ---------------------------------------------------------------------------

/**
 * Pattern: "{creator} - {title}"
 * The " - " separator is a common convention in many download sites.
 */
function matchCreatorDashTitle(
  basename: string,
): { creator: string; title: string } | null {
  const idx = basename.indexOf(' - ');
  if (idx < 1 || idx >= basename.length - 3) return null;
  const creator = basename.slice(0, idx).trim();
  const title = basename.slice(idx + 3).trim();
  if (!creator || !title) return null;
  return { creator, title };
}

/**
 * Pattern: "{title} by {creator}" (case-insensitive " by ")
 */
function matchTitleByCreator(
  basename: string,
): { creator: string; title: string } | null {
  const re = /^(.+)\s+by\s+(.+)$/i;
  const m = re.exec(basename);
  if (!m) return null;
  const title = (m[1] ?? '').trim();
  const creator = (m[2] ?? '').trim();
  if (!title || !creator) return null;
  return { creator, title };
}

/**
 * Pattern: "{title} v{version}" — drop the version suffix, keep title.
 * e.g. "Castle Wall v2.3" → title "Castle Wall"
 */
function matchTitleVersion(basename: string): { title: string } | null {
  const re = /^(.+)\s+v\d[\d.]*$/i;
  const m = re.exec(basename);
  if (!m) return null;
  const title = (m[1] ?? '').trim();
  if (!title) return null;
  return { title };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createFilenameProvider(): ClassifierProvider {
  return {
    name: 'filename',

    async classify(input: ClassifierInput): Promise<PartialClassification> {
      if (input.files.length === 0) return {};

      // Find the "primary" file — first non-stub file.
      const primaryFile = input.files.find((f) => !isStubFile(f.relativePath));
      const targetFile = primaryFile ?? input.files[0]!;
      const basename = stripExt(path.basename(targetFile.relativePath));

      // 1. "{creator} - {title}"
      const dashMatch = matchCreatorDashTitle(basename);
      if (dashMatch) {
        return {
          title: { value: dashMatch.title, confidence: 0.5 },
          creator: { value: dashMatch.creator, confidence: 0.5 },
        };
      }

      // 2. "{title} by {creator}"
      const byMatch = matchTitleByCreator(basename);
      if (byMatch) {
        return {
          title: { value: byMatch.title, confidence: 0.5 },
          creator: { value: byMatch.creator, confidence: 0.5 },
        };
      }

      // 3. "{title} v{version}"
      const versionMatch = matchTitleVersion(basename);
      if (versionMatch) {
        return {
          title: { value: versionMatch.title, confidence: 0.5 },
        };
      }

      // 4. Fallback — bare basename as title (low confidence)
      return {
        title: { value: basename, confidence: 0.3 },
      };
    },
  };
}
