'use client';
// /forge/dispatch — Print queue Kanban + Timeline view.
// Canvas ref: page-print-queue.jsx — PrintQueueKanban (line 63) + PrintQueueTimeline (line 288).
// PrintQueueEditorial deferred to a follow-up PR.
//
// Status column mapping (9 dispatch statuses → 3 Kanban columns):
//   Queued  = pending | converting | claimable | claimed | slicing | dispatched
//   Running = running
//   Done    = succeeded | failed  (last 20, desc completedAt)
//
// Live updates: running jobs polled at 5s via KanbanLiveCard → GET /api/v1/forge/dispatch/:id/status.
// SSE stream (/api/v1/forge/dispatch/:id/status/stream) wired as a follow-up.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyHint, SectionTitle } from '@/components/shell/atoms';
import { ForgeTabs } from '@/components/forge/ForgeTabs';
import { KanbanColumn } from '@/components/forge/KanbanColumn';
import { KanbanLiveCard } from '@/components/forge/KanbanLiveCard';
import { KanbanQueuedCard } from '@/components/forge/KanbanQueuedCard';
import { KanbanFinishedRow } from '@/components/forge/KanbanFinishedRow';
import { TimelineRow } from '@/components/forge/TimelineRow';

// ── DTO type (mirrors _shared.ts:296-312) ─────────────────────────────────

interface DispatchJobDto {
  id: string;
  ownerId: string;
  lootId: string;
  targetKind: string;
  targetId: string;
  status: string;
  convertedFileId: string | null;
  slicedFileId: string | null;
  claimMarker: string | null;
  claimedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  failureReason: string | null;
  failureDetails: string | null;
  createdAt: number;
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchDispatchByStatus(status: string): Promise<{ jobs: DispatchJobDto[] }> {
  const res = await fetch(`/api/v1/forge/dispatch?status=${status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ jobs: DispatchJobDto[] }>;
}

async function fetchDispatchDone(): Promise<{ jobs: DispatchJobDto[] }> {
  // Fetch succeeded + failed separately; combine + sort desc by completedAt; show last 20.
  const [succ, fail] = await Promise.all([
    fetchDispatchByStatus('succeeded'),
    fetchDispatchByStatus('failed'),
  ]);
  const combined = [...succ.jobs, ...fail.jobs]
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
    .slice(0, 20);
  return { jobs: combined };
}

async function fetchAllDispatch(): Promise<{ jobs: DispatchJobDto[] }> {
  // For Timeline view: fetch all jobs (no status filter), paginate up to default limit.
  const res = await fetch('/api/v1/forge/dispatch');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ jobs: DispatchJobDto[] }>;
}

// ── View mode ───────────────────────────────────────────────────────────────

type ViewMode = 'kanban' | 'timeline';

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ForgeDispatchPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('kanban');

  // Queued column: pre-running pipeline statuses.
  // Each status fetched individually to stay within single-status query param.
  // We combine them client-side because the API only accepts one status at a time.
  // Using separate queries per "queued-pipeline" batch here — simpler: fetch all
  // queued-family statuses in parallel and merge.
  const queuedQ = useQuery({
    queryKey: ['forge', 'dispatch', 'queued'],
    queryFn: async () => {
      const statuses = ['pending', 'converting', 'claimable', 'claimed', 'slicing', 'dispatched'];
      const results = await Promise.all(statuses.map(fetchDispatchByStatus));
      const jobs = results.flatMap((r) => r.jobs);
      jobs.sort((a, b) => a.createdAt - b.createdAt); // oldest first in queue
      return { jobs };
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const runningQ = useQuery({
    queryKey: ['forge', 'dispatch', 'running'],
    queryFn: () => fetchDispatchByStatus('running'),
    refetchInterval: 5_000,
    staleTime: 5_000,
  });

  const doneQ = useQuery({
    queryKey: ['forge', 'dispatch', 'done'],
    queryFn: fetchDispatchDone,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  const allQ = useQuery({
    queryKey: ['forge', 'dispatch', 'all'],
    queryFn: fetchAllDispatch,
    enabled: viewMode === 'timeline',
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  // isError check first per carry-forward rule #1.
  const isError =
    queuedQ.isError ||
    runningQ.isError ||
    doneQ.isError ||
    (viewMode === 'timeline' && allQ.isError);

  const isLoading =
    queuedQ.isLoading ||
    runningQ.isLoading ||
    doneQ.isLoading ||
    (viewMode === 'timeline' && allQ.isLoading);

  if (isError) return <EmptyHint>Failed to load dispatch queue.</EmptyHint>;
  if (isLoading) return <EmptyHint>Loading dispatch queue…</EmptyHint>;

  const queuedJobs = queuedQ.data?.jobs ?? [];
  const runningJobs = runningQ.data?.jobs ?? [];
  const doneJobs = doneQ.data?.jobs ?? [];
  const allJobs = allQ.data?.jobs ?? [];

  return (
    <div className="flex flex-col gap-5">
      {/* Forge sub-nav */}
      <ForgeTabs />

      {/* Page header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <SectionTitle meta="dispatch">Print Queue</SectionTitle>
          <div className="mt-1.5 flex items-center gap-3 flex-wrap">
            <span className="font-mono text-[11px] text-fg-faint">
              {runningJobs.length} running
            </span>
            {queuedJobs.length > 0 && (
              <span className="font-mono text-[11px] text-fg-faint">
                · {queuedJobs.length} queued
              </span>
            )}
            {doneJobs.length > 0 && (
              <span className="font-mono text-[11px] text-fg-faint">
                · {doneJobs.length} done
              </span>
            )}
          </div>
        </div>

        {/* View-mode toggle */}
        <div className="flex gap-1 p-[3px] bg-surface border border-hairline rounded-md shrink-0">
          <button
            type="button"
            onClick={() => setViewMode('kanban')}
            aria-pressed={viewMode === 'kanban'}
            className={`font-mono text-[10px] uppercase tracking-[0.8px] px-3 py-[6px] rounded transition-colors ${
              viewMode === 'kanban'
                ? 'bg-accent text-accent-ink font-semibold'
                : 'bg-transparent text-fg-faint hover:text-fg'
            }`}
          >
            Kanban
          </button>
          <button
            type="button"
            onClick={() => setViewMode('timeline')}
            aria-pressed={viewMode === 'timeline'}
            className={`font-mono text-[10px] uppercase tracking-[0.8px] px-3 py-[6px] rounded transition-colors ${
              viewMode === 'timeline'
                ? 'bg-accent text-accent-ink font-semibold'
                : 'bg-transparent text-fg-faint hover:text-fg'
            }`}
          >
            Timeline
          </button>
        </div>
      </div>

      {/* ── Kanban view ─────────────────────────────────────────────────── */}
      {viewMode === 'kanban' && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* Queued column */}
          <KanbanColumn title="Queued" count={queuedJobs.length}>
            {queuedJobs.map((job, i) => (
              <KanbanQueuedCard key={job.id} job={job} position={i + 1} />
            ))}
          </KanbanColumn>

          {/* Running column */}
          <KanbanColumn title="Running" count={runningJobs.length}>
            {runningJobs.map((job) => (
              <KanbanLiveCard key={job.id} job={job} />
            ))}
          </KanbanColumn>

          {/* Done column */}
          <KanbanColumn
            title="Done"
            count={doneJobs.length}
            eyebrow={doneJobs.length === 20 ? 'last 20' : undefined}
          >
            {doneJobs.map((job) => (
              <KanbanFinishedRow key={job.id} job={job} />
            ))}
          </KanbanColumn>
        </div>
      )}

      {/* ── Timeline view ───────────────────────────────────────────────── */}
      {viewMode === 'timeline' && (
        <div className="rounded-lg border border-hairline bg-surface">
          {/* Legend header */}
          <div className="flex items-center gap-4 px-4 py-3 border-b border-hairline">
            <span className="font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
              timeline
            </span>
            <span className="font-serif italic text-[13px] text-fg-muted">
              chronological feed — newest first
            </span>
          </div>

          {allJobs.length === 0 ? (
            <div className="p-4">
              <EmptyHint>No dispatch jobs yet.</EmptyHint>
            </div>
          ) : (
            <ul className="px-4">
              {allJobs.map((job) => (
                <TimelineRow key={job.id} job={job} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
