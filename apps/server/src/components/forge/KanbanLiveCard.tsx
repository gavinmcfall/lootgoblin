// KanbanLiveCard — card for a job in the Running column.
// Shows progress bar, ETA, and basic metadata.
// Progress is polled from GET /api/v1/forge/dispatch/:id/status every 5s.

import { useQuery } from '@tanstack/react-query';
import { MetaBadge } from '@/components/shell/atoms';
import { dispatchStatusLabel, dispatchStatusTone, relativeAge } from './dispatch-labels';

interface DispatchJobDto {
  id: string;
  lootId: string;
  targetId: string;
  status: string;
  startedAt: number | null;
  failureReason: string | null;
  createdAt: number;
}

interface StatusDto {
  dispatch_job_id: string;
  status: string;
  progress_pct: number | null;
  last_status_at: number | null;
}

async function fetchJobStatus(id: string): Promise<StatusDto> {
  const res = await fetch(`/api/v1/forge/dispatch/${id}/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<StatusDto>;
}

interface KanbanLiveCardProps {
  job: DispatchJobDto;
}

export function KanbanLiveCard({ job }: KanbanLiveCardProps) {
  // Poll status for running jobs at 5s — SSE stream wiring is a follow-up.
  const statusQ = useQuery({
    queryKey: ['forge', 'dispatch', job.id, 'status'],
    queryFn: () => fetchJobStatus(job.id),
    refetchInterval: 5_000,
    staleTime: 1_000,
  });

  const tone = dispatchStatusTone(job.status);
  const label = dispatchStatusLabel(job.status);

  // Progress from live poll, or fall back to null (no bar rendered).
  const progressPct = statusQ.data?.progress_pct ?? null;

  // TODO(loot-name-batch): backend has no /api/v1/loot/by-ids endpoint;
  // fetching name per dispatch row is N+1. Showing lootId substring as
  // identifier until the batch endpoint lands.
  const lootDisplay = `Nº ${job.lootId.slice(0, 8)}`;

  return (
    <article className="rounded-md border border-running bg-running-bg p-3">
      {/* Header row: status badge + age */}
      <div className="flex items-center gap-2 mb-2">
        <MetaBadge tone={tone}>{label}</MetaBadge>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-fg-faint">
          {job.startedAt ? relativeAge(job.startedAt) : relativeAge(job.createdAt)}
        </span>
      </div>

      {/* Loot identifier */}
      <div className="font-mono text-[12px] text-fg mb-1 truncate">{lootDisplay}</div>

      {/* Target identifier */}
      <div className="font-mono text-[9.5px] text-fg-faint mb-2 truncate">
        target: {job.targetId.slice(0, 12)}…
      </div>

      {/* Progress bar */}
      {progressPct !== null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPct)}
          aria-label="Print progress"
          className="h-1 rounded-full bg-hairline overflow-hidden mb-2"
        >
          <div
            className="h-full bg-running rounded-full transition-all duration-500"
            style={{ width: `${Math.min(100, Math.max(0, progressPct)).toFixed(1)}%` }}
          />
        </div>
      )}

      {/* Progress pct label */}
      {progressPct !== null && (
        <div className="font-mono text-[10px] text-fg-muted">
          {Math.round(progressPct)}% complete
        </div>
      )}
    </article>
  );
}
