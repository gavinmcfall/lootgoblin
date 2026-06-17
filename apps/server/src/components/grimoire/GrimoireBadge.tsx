// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// GrimoireBadge — kind chip for slicer-profile / print-setting entries.
// Uses MetaBadge with neutral tone (steady-state label, not an outcome).
// Canvas reference: GrimoireBadge (page-grimoire.jsx line 22–35).

import { MetaBadge } from '@/components/shell/atoms';

interface GrimoireBadgeProps {
  kind: 'slicer-profile' | 'print-setting';
}

export function GrimoireBadge({ kind }: GrimoireBadgeProps) {
  return (
    <MetaBadge tone="neutral">
      {kind === 'slicer-profile' ? 'Slicer profile' : 'Print setting'}
    </MetaBadge>
  );
}
