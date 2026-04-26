/**
 * preview.ts — Builds TemplateOption[] from a list of templates and classified
 * AdoptionCandidates.
 *
 * For each template:
 *   1. Parse the template via T2 parseTemplate.
 *   2. For each candidate, build a metadata record from its classification and
 *      resolve the template.
 *   3. Collect: resolved paths, collisions (same path from multiple candidates),
 *      incompatibles (template resolution failed), up to 5 examples.
 *   4. Sort output by predictedLootCount desc.
 */

import type { AdoptionCandidate, TemplateOption } from '../adoption';
import { parseTemplate, resolveTemplate } from '../path-template';
import type { ResolveReason } from '../path-template';

// ---------------------------------------------------------------------------
// buildTemplateOptions
// ---------------------------------------------------------------------------

/**
 * Pure function — builds TemplateOption[] for each candidate template.
 * Output is sorted by predictedLootCount descending.
 */
export function buildTemplateOptions(
  templates: string[],
  candidates: AdoptionCandidate[],
): TemplateOption[] {
  const options: TemplateOption[] = [];

  for (const template of templates) {
    let parsed: ReturnType<typeof parseTemplate>;
    try {
      parsed = parseTemplate(template);
    } catch {
      // Malformed template — skip it.
      continue;
    }

    // Track resolved paths: resolvedPath → candidateId[]
    const pathMap = new Map<string, string[]>();
    const incompatible: TemplateOption['incompatible'] = [];
    const examples: TemplateOption['examples'] = [];

    for (const candidate of candidates) {
      const metadata = classificationToMetadata(candidate);
      const verdict = resolveTemplate(parsed, { metadata, targetOS: 'linux' });

      if (!verdict.ok) {
        incompatible.push({
          candidateId: candidate.id,
          reason: verdict.reason as ResolveReason,
        });
        continue;
      }

      const resolvedPath = verdict.path;

      // Track path → candidates for collision detection
      if (!pathMap.has(resolvedPath)) {
        pathMap.set(resolvedPath, []);
      }
      pathMap.get(resolvedPath)!.push(candidate.id);

      // Collect up to 5 examples
      if (examples.length < 5) {
        examples.push({
          candidateId: candidate.id,
          currentPath: candidate.folderRelativePath,
          proposedPath: resolvedPath,
        });
      }
    }

    // Build collision list: paths where >1 candidate resolves to the same value
    const collisions: TemplateOption['collisions'] = [];
    for (const [proposedPath, candidateIds] of pathMap) {
      if (candidateIds.length > 1) {
        collisions.push({ proposedPath, candidateIds });
      }
    }

    // predictedLootCount: candidates that resolved without collision
    // (i.e. they have a unique path + they succeeded)
    let predictedLootCount = 0;
    for (const candidateIds of pathMap.values()) {
      if (candidateIds.length === 1) predictedLootCount++;
    }

    options.push({
      template,
      predictedLootCount,
      collisions,
      incompatible,
      examples,
    });
  }

  // Sort by predictedLootCount descending
  options.sort((a, b) => b.predictedLootCount - a.predictedLootCount);

  return options;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a flat metadata record from a candidate's classification.
 * This is the input to resolveTemplate().
 */
function classificationToMetadata(candidate: AdoptionCandidate): Record<string, unknown> {
  const { classification } = candidate;
  const meta: Record<string, unknown> = {};

  if (classification.title?.value !== undefined) {
    meta['title'] = classification.title.value;
  }
  if (classification.creator?.value !== undefined) {
    meta['creator'] = classification.creator.value;
  }
  if (classification.description?.value !== undefined) {
    meta['description'] = classification.description.value;
  }
  if (classification.license?.value !== undefined) {
    meta['license'] = classification.license.value;
  }
  if (classification.tags?.value !== undefined) {
    meta['tags'] = classification.tags.value;
  }
  if (classification.primaryFormat?.value !== undefined) {
    meta['primaryFormat'] = classification.primaryFormat.value;
  }

  return meta;
}
