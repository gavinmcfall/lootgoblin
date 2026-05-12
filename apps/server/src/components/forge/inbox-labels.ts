// Shared label helpers for the Forge inboxes UI.
// Single source of truth across InboxKindIcon, PairingAutoRow,
// PairingAmbiguousRow, PairingUnknownRow, AmbiguousDetail, and
// the /forge/inboxes page.

import { type Tone } from '@/components/shell/atoms';

// ---------------------------------------------------------------------------
// File-kind label
// ---------------------------------------------------------------------------

export type FileKind = 'mini' | 'func' | 'grid' | 'unknown';

/** Human-readable label for a file kind glyph. */
export function fileKindLabel(kind: string): string {
  switch (kind) {
    case 'mini':
      return 'Miniature';
    case 'func':
      return 'Functional';
    case 'grid':
      return 'Gridfinity';
    default:
      return 'Unknown file type';
  }
}

// ---------------------------------------------------------------------------
// Pairing state label + tone
// ---------------------------------------------------------------------------

export type PairingState = 'auto' | 'ambiguous' | 'unknown';

/** Human-readable label for a pairing state. */
export function pairingStateLabel(state: PairingState): string {
  switch (state) {
    case 'auto':
      return 'Auto-paired';
    case 'ambiguous':
      return 'Ambiguous';
    case 'unknown':
      return 'Unknown';
  }
}

/** Semantic tone for the pairing state MetaBadge. */
export function pairingStateTone(state: PairingState): Tone {
  switch (state) {
    case 'auto':
      return 'success';
    case 'ambiguous':
      return 'running';
    case 'unknown':
      return 'danger';
  }
}

// ---------------------------------------------------------------------------
// Confidence tier label
// ---------------------------------------------------------------------------

/** Short tier description for a confidence score (0–1). */
export function confidenceTierLabel(conf: number): string {
  if (conf >= 0.85) return 'high confidence';
  if (conf >= 0.5) return 'moderate confidence';
  return 'low confidence';
}
