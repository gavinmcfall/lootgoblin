// Adoption wizard — shared DTO types + helpers.
// Mirrors the backend DTOs in
// apps/server/src/app/api/v1/stash-roots/[id]/adoption/_shared.ts.
// Visual language ported from planning/design-system/lib/page-adoption.jsx,
// but the 5 mock steps collapse to 4 real steps keyed on real endpoints.

export interface StashRootDto {
  id: string;
  ownerId: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface StashRootsResponse {
  items: StashRootDto[];
  total: number;
  limit: number;
  offset: number;
}

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
  expiresAt: string;
}

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

export interface ApplyReportDto {
  collectionId: string;
  adoptedCount: number;
  skippedCount: number;
  errors: Array<{ candidateId: string; reason: string }>;
}

export type AdoptionMode = 'in-place' | 'copy-then-cleanup';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Human-readable byte size. 1024-byte steps with decimal KB/MB/GB labels. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  const rounded = value >= 100 || exp === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[exp]}`;
}

/** Confidence (0..1) → tone for a subtle chip. Low-confidence reads as `running`. */
export function confidenceTone(confidence: number): 'success' | 'running' | 'neutral' {
  if (confidence >= 0.85) return 'success';
  if (confidence >= 0.6) return 'neutral';
  return 'running';
}

/**
 * Heuristic "Recommended" pick across preview options. Clearly UI-derived (the
 * backend has no recommended field): fewest collisions, then most predicted
 * loot. Returns the template string of the winner, or null when no options.
 */
export function recommendedTemplate(options: TemplateOptionDto[]): string | null {
  if (options.length === 0) return null;
  const best = [...options].sort((a, b) => {
    if (a.collisionCount !== b.collisionCount) return a.collisionCount - b.collisionCount;
    return b.predictedLootCount - a.predictedLootCount;
  })[0]!;
  return best.template;
}

/** Map a server error code to friendly inline copy. */
export function adoptionErrorMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case 'not-found':
      return 'This stash root or proposal could not be found. It may have been removed, or the proposal expired — rescan to continue.';
    case 'forbidden':
      return 'You do not have permission to adopt this stash root.';
    case 'path-not-accessible':
      return 'The stash root path is not accessible on disk. Check the folder still exists and is readable, then try again.';
    case 'scan-failed':
      return 'The scan could not finish. Check the server logs and try again.';
    case 'invalid-candidate-ids':
      return 'Some selected items are no longer part of this proposal. Rescan and try again.';
    case 'apply-failed':
      return 'Adoption could not be completed. Your files were not changed — try again.';
    case 'invalid-body':
      return 'The request was rejected. Rescan and try again.';
    default:
      return fallback ?? 'Something went wrong. Please try again.';
  }
}
