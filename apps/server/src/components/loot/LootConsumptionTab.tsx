// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// LootConsumptionTab — per-Loot consumption history via ConsumptionLootEmbed.
// Wires ConsumptionLootEmbed (canvas-port #5) into its first consumer.
// Canvas ref: ConsumptionLootEmbed (page-consumption.jsx line 383–412).

import { useQuery } from '@tanstack/react-query';
import { EmptyHint, SectionTitle } from '@/components/shell/atoms';
import { ConsumptionLootEmbed } from '@/components/reports/ConsumptionLootEmbed';

interface LootConsumptionTabProps {
  lootId: string;
}

interface ConsumptionRow {
  date: string;
  material: string;
  massG: number;
  provenance: 'measured' | 'estimated' | 'entered' | 'derived' | 'computed' | 'system';
}

interface ConsumptionResponse {
  totalKg: number;
  printCount: number;
  avgGrams: number;
  rows: ConsumptionRow[];
}

export function LootConsumptionTab({ lootId }: LootConsumptionTabProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['loot', lootId, 'consumption'],
    queryFn: async (): Promise<ConsumptionResponse> => {
      const res = await fetch(`/api/v1/loot/${lootId}/consumption`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  return (
    <div>
      <SectionTitle>Consumption</SectionTitle>

      {isError && <EmptyHint>Failed to load consumption data.</EmptyHint>}
      {!isError && isLoading && <EmptyHint>Loading consumption data…</EmptyHint>}
      {!isError && !isLoading && data && data.printCount === 0 && (
        <EmptyHint>No print history for this Loot yet.</EmptyHint>
      )}
      {!isError && !isLoading && data && data.printCount > 0 && (
        <ConsumptionLootEmbed
          totalKg={data.totalKg}
          printCount={data.printCount}
          avgGrams={data.avgGrams}
          rows={data.rows}
        />
      )}
    </div>
  );
}
