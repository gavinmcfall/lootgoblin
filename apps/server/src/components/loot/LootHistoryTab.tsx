// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// LootHistoryTab — ledger events filtered to this Loot.
// Full Ledger endpoint is canvas-port #14 territory; shows EmptyHint until then.
// Canvas ref: BoldDetailBody "The story of this item" (page-detail-bold.jsx line 205–233).

import { EmptyHint, SectionTitle } from '@/components/shell/atoms';

interface LootHistoryTabProps {
  lootId: string;
}

export function LootHistoryTab({ lootId: _lootId }: LootHistoryTabProps) {
  return (
    <div>
      <SectionTitle>History</SectionTitle>
      {/* TODO(canvas-port-14): wire against /api/v1/ledger?subjectId=<lootId>
          once the full Ledger endpoint ships. The Ledger endpoint is tracked
          as canvas-port #14 (receipts/ledger). */}
      <EmptyHint>
        Ledger-per-loot history coming in canvas-port #14.
      </EmptyHint>
    </div>
  );
}
