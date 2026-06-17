// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// /loot/[id] — Loot detail page.
// Canvas ref: DetailPageBold (page-detail-bold.jsx).
// Canvas-port #9 in the autonomous-shipment roadmap.

import { use, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { EmptyHint } from '@/components/shell/atoms';
import { LootMasthead } from '@/components/loot/LootMasthead';
import { LootDetailTabs, type LootTab } from '@/components/loot/LootDetailTabs';
import { LootFilesTab } from '@/components/loot/LootFilesTab';
import { LootGrimoireTab } from '@/components/loot/LootGrimoireTab';
import { LootConsumptionTab } from '@/components/loot/LootConsumptionTab';
import { LootHistoryTab } from '@/components/loot/LootHistoryTab';

// ── DTO types ───────────────────────────────────────────────────────────────

interface LootFile {
  id: string;
  kind: string;
  relativePath: string;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string;
}

interface LootDto {
  id: string;
  collectionId: string;
  title: string;
  description: string | null;
  tags: string[];
  creator: string | null;
  license: string | null;
  sourceItemId: string | null;
  contentSummary: unknown | null;
  fileMissing: boolean;
  parentLootId: string | null;
  createdAt: string;
  updatedAt: string;
  files: LootFile[];
}

// ── Fetch helper ─────────────────────────────────────────────────────────────

async function fetchLoot(id: string): Promise<LootDto> {
  const res = await fetch(`/api/v1/loot/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function LootDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState<LootTab>('files');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['loot', id],
    queryFn: () => fetchLoot(id),
    staleTime: 30_000,
  });

  if (isError) {
    return (
      <div className="space-y-4">
        <EmptyHint>Failed to load Loot. It may have been deleted or you may not have permission.</EmptyHint>
        <Link
          href="/stash"
          className="font-mono text-[11px] uppercase tracking-[1px] text-accent hover:underline"
        >
          ← Back to stash
        </Link>
      </div>
    );
  }

  if (isLoading || !data) {
    return <EmptyHint>Loading…</EmptyHint>;
  }

  const loot = data;

  return (
    <div>
      {/* Breadcrumb strip */}
      <div className="mb-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.8px] text-fg-faint">
        <Link href="/stash" className="hover:text-fg">
          Stash
        </Link>
        <span>/</span>
        <span className="text-fg">{loot.title}</span>
      </div>

      {/* Masthead */}
      <LootMasthead
        id={loot.id}
        title={loot.title}
        description={loot.description}
        tags={loot.tags}
        creator={loot.creator}
        license={loot.license}
        createdAt={loot.createdAt}
        fileMissing={loot.fileMissing}
        parentLootId={loot.parentLootId}
        files={loot.files}
      />

      {/* Tabs */}
      <LootDetailTabs active={tab} onTab={setTab} />

      {/* Tab body */}
      {tab === 'files' && <LootFilesTab lootId={loot.id} files={loot.files} />}
      {tab === 'grimoire' && <LootGrimoireTab lootId={loot.id} />}
      {tab === 'consumption' && <LootConsumptionTab lootId={loot.id} />}
      {tab === 'history' && <LootHistoryTab lootId={loot.id} />}
    </div>
  );
}
