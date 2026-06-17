// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// search-palette-labels.ts
// Canonical kind labels for the kind-chip shown on each result row.
// Add new entries as future cross-kind search indexes land.

export type ResultKind =
  | 'loot'
  | 'library'
  | 'scout'
  | 'watch'
  | 'material'
  | 'cmd';

export const KIND_LABEL: Record<ResultKind, string> = {
  loot: 'Loot',
  library: 'Library',
  scout: 'Scout',
  watch: 'Watch',
  material: 'Material',
  cmd: 'Cmd',
};
