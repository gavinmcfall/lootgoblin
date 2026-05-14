/**
 * _shared.ts — DTO shapes + mappers for the Adoption HTTP layer
 *
 * All three adoption routes (scan / preview / apply) share these types
 * and mapping utilities.
 *
 * NOTE ON TYPE ALIASES:
 *   The orchestrator exports `AdoptionProposal` (scan result).
 *   The proposal-cache exports `AdoptionProposal` (cache wrapper).
 *   Both are imported here under distinct aliases to avoid name collisions.
 */

import type { AdoptionCandidate } from '@/stash/adoption';
import type { AdoptionProposal as CacheProposal } from '@/stash/adoption/proposal-cache';
import { PROPOSAL_TTL_MS } from '@/stash/adoption/proposal-cache';

// ---------------------------------------------------------------------------
// DTO interfaces
// ---------------------------------------------------------------------------

export interface CandidateDto {
  id: string;
  folderRelativePath: string;
  fileCount: number;
  totalBytes: number;
  classification: {
    title: string | null;
    creator: string | null;
    confidence: number;
    providerHits: string[];
  };
}

export interface ScanResponseDto {
  proposalId: string;
  candidates: CandidateDto[];
  derivedTemplates: { templates: string[]; patternDetected: boolean };
  /** ISO timestamp when the proposal expires. */
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * Maps an `AdoptionCandidate` (full internal type) to `CandidateDto` (client
 * payload). Intentionally strips `files[]` — the wizard doesn't need per-file
 * detail at the candidate-picker stage (documented in plan DTO shape note).
 *
 * `fileCount` and `totalBytes` are derived from `candidate.files`.
 * `classification` extracts the resolved values from `ClassifiedField<T>`
 * wrappers and collects provider sources as `providerHits`.
 */
export function toCandidateDto(candidate: AdoptionCandidate): CandidateDto {
  const { id, folderRelativePath, files, classification } = candidate;

  const fileCount = files.length;
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  // Collect provider sources from all resolved fields as providerHits.
  const providerHits: string[] = [];
  for (const field of [
    classification.title,
    classification.creator,
    classification.description,
    classification.license,
    classification.tags,
    classification.primaryFormat,
  ]) {
    if (field && !providerHits.includes(field.source)) {
      providerHits.push(field.source);
    }
  }

  // Overall confidence: max across title/creator (the two fields the plan
  // surfaces in the DTO). Falls back to 0 if neither field is present.
  const titleConf = classification.title?.confidence ?? 0;
  const creatorConf = classification.creator?.confidence ?? 0;
  const confidence = Math.max(titleConf, creatorConf);

  return {
    id,
    folderRelativePath,
    fileCount,
    totalBytes,
    classification: {
      title: classification.title?.value ?? null,
      creator: classification.creator?.value ?? null,
      confidence,
      providerHits,
    },
  };
}

/**
 * Builds the full `ScanResponseDto` from proposal cache state.
 */
export function toScanResponseDto(
  proposalId: string,
  candidates: AdoptionCandidate[],
  derivedTemplates: CacheProposal['derivedTemplates'],
): ScanResponseDto {
  return {
    proposalId,
    candidates: candidates.map(toCandidateDto),
    derivedTemplates,
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
  };
}
