// KanbanQueuedCard — card for a job in the Queued column.
// Shows position in queue + loot identifier + status badge.
//
// Cards use <article> not <Tile> — Tile is for generic framing; <article>
// is the semantically correct element for a self-contained job card.

import { MetaBadge } from '@/components/shell/atoms';
import { dispatchStatusLabel, dispatchStatusTone, relativeAge } from './dispatch-labels';

interface DispatchJobDto {
  id: string;
  lootId: string;
  status: string;
  createdAt: number;
}

interface KanbanQueuedCardProps {
  job: DispatchJobDto;
  /** 1-based position within the queued column. */
  position: number;
}

export function KanbanQueuedCard({ job, position }: KanbanQueuedCardProps) {
  const tone = dispatchStatusTone(job.status);
  const label = dispatchStatusLabel(job.status);

  // TODO(loot-name-batch): backend has no /api/v1/loot/by-ids endpoint;
  // fetching name per dispatch row is N+1. Showing lootId substring as
  // identifier until the batch endpoint lands.
  const lootDisplay = `Nº ${job.lootId.slice(0, 8)}`;

  return (
    <article className="flex items-center gap-2.5 rounded-md border border-hairline bg-surface-2 px-2.5 py-2">
      {/* Position badge */}
      <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded border border-hairline bg-surface font-mono text-[10.5px] font-semibold text-fg-muted">
        {position}
      </div>

      {/* Loot identifier */}
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px] text-fg">{lootDisplay}</div>
        <div className="font-mono text-[9.5px] text-fg-faint mt-0.5">
          {relativeAge(job.createdAt)}
        </div>
      </div>

      {/* Status */}
      <MetaBadge tone={tone}>{label}</MetaBadge>
    </article>
  );
}
