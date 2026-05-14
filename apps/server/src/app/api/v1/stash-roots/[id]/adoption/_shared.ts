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

import type { AdoptionCandidate, TemplateOption, AdoptionReport } from '@/stash/adoption';
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

// ---------------------------------------------------------------------------
// Preview DTOs
// ---------------------------------------------------------------------------

export interface TemplateOptionDto {
  template: string;
  predictedLootCount: number;
  collisionCount: number;
  incompatibleCount: number;
  examples: Array<{ candidateId: string; resolvedPath: string }>;
}

export interface PreviewResponseDto {
  options: TemplateOptionDto[];
}

// ---------------------------------------------------------------------------
// Preview mapper
// ---------------------------------------------------------------------------

/**
 * Maps a `TemplateOption` (internal shape) to `TemplateOptionDto` (client payload).
 *
 * Field projection:
 *   - collisionCount  = collisions.length
 *   - incompatibleCount = incompatible.length
 *   - examples        = up to 5 items; `proposedPath` field renamed to `resolvedPath`
 */
export function toTemplateOptionDto(option: TemplateOption): TemplateOptionDto {
  return {
    template: option.template,
    predictedLootCount: option.predictedLootCount,
    collisionCount: option.collisions.length,
    incompatibleCount: option.incompatible.length,
    examples: option.examples.map((ex) => ({
      candidateId: ex.candidateId,
      resolvedPath: ex.proposedPath,
    })),
  };
}

/**
 * Builds the full `PreviewResponseDto` from a `TemplateOption[]`.
 */
export function toPreviewResponseDto(options: TemplateOption[]): PreviewResponseDto {
  return {
    options: options.map(toTemplateOptionDto),
  };
}

// ---------------------------------------------------------------------------
// Apply DTOs
// ---------------------------------------------------------------------------

export interface ApplyReportDto {
  collectionId: string;
  adoptedCount: number;
  skippedCount: number;
  errors: Array<{ candidateId: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Apply mapper
// ---------------------------------------------------------------------------

/**
 * Maps an `AdoptionReport` (orchestrator shape) + the recovered `collectionId`
 * to `ApplyReportDto` (client payload).
 *
 * Field projection:
 *   - collectionId   = recovered separately (the report does NOT carry it —
 *                      the applier creates the Collection internally).
 *   - adoptedCount   = report.lootsCreated
 *   - skippedCount   = report.skippedCandidates.length
 *   - errors         = report.errors mapped { candidateId, error } → { candidateId, reason }.
 *                      Skipped candidates are counted in skippedCount but are
 *                      NOT errors — they are expected outcomes (missing fields,
 *                      collisions). Only report.errors are real failures.
 */
export function toApplyReportDto(
  report: AdoptionReport,
  collectionId: string,
): ApplyReportDto {
  return {
    collectionId,
    adoptedCount: report.lootsCreated,
    skippedCount: report.skippedCandidates.length,
    errors: report.errors.map((e) => ({
      candidateId: e.candidateId,
      reason: e.error,
    })),
  };
}
