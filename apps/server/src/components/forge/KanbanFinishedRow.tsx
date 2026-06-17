// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// KanbanFinishedRow — compact row for a job in the Done column.
// Renders succeeded + failed terminal states.
//
// Cards use <article> not <Tile> — Tile is for generic framing; <article>
// is the semantically correct element for a self-contained job card.

import { MetaBadge } from '@/components/shell/atoms';
import { dispatchStatusLabel, dispatchStatusTone, relativeAge } from './dispatch-labels';

interface DispatchJobDto {
  id: string;
  lootId: string;
  status: string;
  completedAt: number | null;
  failureReason: string | null;
  createdAt: number;
}

interface KanbanFinishedRowProps {
  job: DispatchJobDto;
}

export function KanbanFinishedRow({ job }: KanbanFinishedRowProps) {
  const tone = dispatchStatusTone(job.status);
  const label = dispatchStatusLabel(job.status);
  const timestamp = job.completedAt ?? job.createdAt;

  // TODO(loot-name-batch): backend has no /api/v1/loot/by-ids endpoint;
  // fetching name per dispatch row is N+1. Showing lootId substring as
  // identifier until the batch endpoint lands.
  const lootDisplay = `Nº ${job.lootId.slice(0, 8)}`;

  return (
    <article className="flex items-center gap-2.5 rounded-md border border-hairline bg-surface px-2.5 py-2">
      {/* Tone dot */}
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : 'bg-fg-faint'
        }`}
      />

      {/* Loot identifier + timestamp */}
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px] text-fg">{lootDisplay}</div>
        {job.failureReason && (
          <div className="truncate font-serif italic text-[11px] text-danger mt-0.5">
            {job.failureReason}
          </div>
        )}
        <div className="font-mono text-[9.5px] text-fg-faint mt-0.5">{relativeAge(timestamp)}</div>
      </div>

      {/* Status badge */}
      <MetaBadge tone={tone}>{label}</MetaBadge>
    </article>
  );
}
