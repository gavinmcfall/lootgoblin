/**
 * template-deriver.ts — Observes candidate folder paths and infers the
 * most likely path template for the observed library layout.
 *
 * Heuristics:
 *   1. Most candidates have depth 2 (two folder levels) → propose
 *      `{creator|slug}/{title|slug}` (first = creator, second = title).
 *   2. Most candidates have depth 1 (one folder level) → propose `{title|slug}`.
 *   3. All candidates are at depth 1 → propose `{title|slug}`.
 *   4. Depth varies wildly (no clear majority) → return empty list →
 *      triggers noPatternDetected=true in the orchestrator.
 *
 * "Most" = strict majority (>50% of candidates).
 * Top-level files (folderRelativePath with no slash, i.e. depth 0) are
 * ignored for pattern detection — they don't contribute to the depth histogram.
 */

import type { AdoptionCandidate } from '../adoption';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeriveTemplatesResult = {
  templates: string[];
  patternDetected: boolean;
};

// ---------------------------------------------------------------------------
// deriveTemplates
// ---------------------------------------------------------------------------

/**
 * Pure function — given classified candidates, examine their folderRelativePath
 * depths and propose templates.
 */
export function deriveTemplates(candidates: AdoptionCandidate[]): DeriveTemplatesResult {
  if (candidates.length === 0) {
    return { templates: [], patternDetected: false };
  }

  // Compute depth for each candidate folder.
  // depth 0 = top-level (no slash in folderRelativePath or empty string)
  // depth 1 = one level deep ("creator")
  // depth 2 = two levels deep ("creator/title")
  // depth N = N slashes in the path

  const depthCounts = new Map<number, number>();

  for (const candidate of candidates) {
    const folder = candidate.folderRelativePath;
    // Depth 0 = no slash or empty
    const depth = folder === '' ? 0 : (folder.match(/\//g) ?? []).length + 1;
    depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);
  }

  // Ignore top-level files (depth 0) for pattern detection.
  depthCounts.delete(0);

  if (depthCounts.size === 0) {
    // All candidates are top-level files — no pattern.
    return { templates: [], patternDetected: false };
  }

  const total = Array.from(depthCounts.values()).reduce((a, b) => a + b, 0);

  // Find the majority depth.
  let majorityDepth: number | null = null;
  let majorityCount = 0;
  for (const [depth, count] of depthCounts) {
    if (count > majorityCount) {
      majorityCount = count;
      majorityDepth = depth;
    }
  }

  const majorityFraction = majorityCount / total;

  // Require strict majority (>50%) — if depth varies wildly, no pattern.
  if (majorityFraction <= 0.5) {
    return { templates: [], patternDetected: false };
  }

  if (majorityDepth === 1) {
    return {
      templates: ['{title|slug}'],
      patternDetected: true,
    };
  }

  if (majorityDepth === 2) {
    return {
      templates: ['{creator|slug}/{title|slug}'],
      patternDetected: true,
    };
  }

  // 3+ levels deep — collapse into a 2-level template assumption (first = creator,
  // last = title) as best guess, but still mark as detected.
  if (majorityDepth !== null && majorityDepth >= 3) {
    return {
      templates: ['{creator|slug}/{title|slug}'],
      patternDetected: true,
    };
  }

  return { templates: [], patternDetected: false };
}
