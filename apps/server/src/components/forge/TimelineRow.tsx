// TimelineRow — a single entry in the Timeline view of the dispatch queue.
// Presents a chronological feed of all jobs regardless of status.
// Used inside PrintQueueTimeline's ordered list.

import { MetaBadge } from '@/components/shell/atoms';
import {
  dispatchStatusLabel,
  dispatchStatusTone,
  dispatchStatusColumn,
  relativeAge,
} from './dispatch-labels';

interface DispatchJobDto {
  id: string;
  lootId: string;
  targetId: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  failureReason: string | null;
  createdAt: number;
}

interface TimelineRowProps {
  job: DispatchJobDto;
}

export function TimelineRow({ job }: TimelineRowProps) {
  const tone = dispatchStatusTone(job.status);
  const label = dispatchStatusLabel(job.status);
  const column = dispatchStatusColumn(job.status);

  // Anchor timestamp: completed if done, started if running, created otherwise.
  const anchorMs =
    column === 'done' ? (job.completedAt ?? job.createdAt) :
    column === 'running' ? (job.startedAt ?? job.createdAt) :
    job.createdAt;

  // TODO(loot-name-batch): backend has no /api/v1/loot/by-ids endpoint;
  // fetching name per dispatch row is N+1. Showing lootId substring as
  // identifier until the batch endpoint lands.
  const lootDisplay = `Nº ${job.lootId.slice(0, 8)}`;

  return (
    <li className="flex items-start gap-3 py-3 border-b border-hairline last:border-b-0">
      {/* Timeline dot + vertical line */}
      <div className="relative flex flex-col items-center shrink-0">
        <span
          className={`mt-1 h-2.5 w-2.5 rounded-full ${
            tone === 'running' ? 'bg-running shadow-[0_0_0_3px_theme(colors.running/0.2)]' :
            tone === 'success' ? 'bg-success' :
            tone === 'danger' ? 'bg-danger' :
            'bg-fg-faint'
          }`}
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <MetaBadge tone={tone}>{label}</MetaBadge>
          <span className="font-mono text-[10px] text-fg-faint">{relativeAge(anchorMs)}</span>
        </div>

        {/* Loot identifier */}
        <div className="font-mono text-[12px] text-fg truncate">{lootDisplay}</div>

        {/* Target */}
        <div className="font-mono text-[9.5px] text-fg-faint mt-0.5 truncate">
          target: {job.targetId.slice(0, 12)}…
        </div>

        {/* Failure reason if present */}
        {job.failureReason && (
          <div className="font-serif italic text-[11px] text-danger mt-1 truncate">
            {job.failureReason}
          </div>
        )}
      </div>

      {/* Column label (context for mixed-status feed) */}
      <div className="shrink-0 font-mono text-[9.5px] text-fg-faint uppercase tracking-[0.8px]">
        {column}
      </div>
    </li>
  );
}
