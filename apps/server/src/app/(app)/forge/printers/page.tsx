'use client';
// /forge/printers — Fleet dashboard (Casual grid + Power table toggle).
// Canvas ref: FleetCasualGrid (line 129) + FleetPowerTable (line 246).
//
// Per-printer state derived client-side:
//   printer.active === false          → 'disabled'
//   has a 'running' dispatch job       → 'running'
//   has 'queued' dispatch jobs         → 'queue'
//   otherwise                          → 'idle'
//
// TODO: real-time 'error' and 'offline' states require V2-005f status feeds;
// surfaced as 'idle' until wired.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyHint, MetaBadge, SectionTitle } from '@/components/shell/atoms';
import { FleetCard } from '@/components/forge/FleetCard';
import { FleetPowerRow } from '@/components/forge/FleetPowerRow';
import { PrinterDot } from '@/components/forge/PrinterDot';
import { printerKindLabel, type PrinterState } from '@/components/forge/forge-labels';

// ── DTO types (mirrors route.ts responses) ─────────────────────────────────

interface PrinterDto {
  id: string;
  ownerId: string;
  kind: string;
  name: string;
  connectionConfig: Record<string, unknown>;
  statusLastSeen: number | null;
  active: boolean;
  createdAt: number;
}

interface DispatchJobDto {
  id: string;
  ownerId: string;
  lootId: string;
  targetKind: string;
  targetId: string;
  status: string;
  createdAt: number;
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchPrinters(): Promise<{ printers: PrinterDto[] }> {
  const res = await fetch('/api/v1/forge/printers');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ printers: PrinterDto[] }>;
}

async function fetchDispatch(status: 'running' | 'queued'): Promise<{ jobs: DispatchJobDto[] }> {
  const res = await fetch(`/api/v1/forge/dispatch?status=${status}&targetKind=printer`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ jobs: DispatchJobDto[] }>;
}

// ── Derive per-printer state ────────────────────────────────────────────────

interface PrinterViewModel {
  id: string;
  name: string;
  kind: string;
  state: PrinterState;
  protocol: string;
  jobName?: string;
  progress?: number;
  eta?: string;
  disabled: boolean;
}

function deriveState(
  printer: PrinterDto,
  runningJobs: DispatchJobDto[],
  queuedJobs: DispatchJobDto[],
): PrinterState {
  if (!printer.active) return 'disabled';
  if (runningJobs.some((j) => j.targetId === printer.id)) return 'running';
  if (queuedJobs.some((j) => j.targetId === printer.id)) return 'queue';
  return 'idle';
}

function toViewModel(
  printer: PrinterDto,
  runningJobs: DispatchJobDto[],
  queuedJobs: DispatchJobDto[],
): PrinterViewModel {
  const state = deriveState(printer, runningJobs, queuedJobs);
  const runningJob = runningJobs.find((j) => j.targetId === printer.id);

  // connectionConfig may carry a 'host' field for display.
  const cfg = printer.connectionConfig;
  const host = typeof cfg?.host === 'string' ? (cfg.host as string) : undefined;
  const protocol = host ? `${printerKindLabel(printer.kind)} · ${host}` : printerKindLabel(printer.kind);

  return {
    id: printer.id,
    name: printer.name,
    kind: printer.kind,
    state,
    protocol,
    jobName: runningJob ? `Job ${runningJob.id.slice(0, 8)}…` : undefined,
    // TODO: real progress + ETA from V2-005f status feeds (GET /api/v1/forge/dispatch/:id/status)
    disabled: !printer.active,
  };
}

// ── View mode toggle ────────────────────────────────────────────────────────

type ViewMode = 'casual' | 'power';

// ── Summary counts ──────────────────────────────────────────────────────────

function summarise(vms: PrinterViewModel[]) {
  return {
    total: vms.length,
    running: vms.filter((v) => v.state === 'running').length,
    idle: vms.filter((v) => v.state === 'idle').length,
    disabled: vms.filter((v) => v.state === 'disabled').length,
  };
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ForgeFleetPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('casual');

  // Nested queryKey arrays enable hierarchical invalidation —
  // `queryClient.invalidateQueries({ queryKey: ['forge'] })` refreshes everything.
  // staleTime under refetchInterval prevents mount-triggered duplicate fetches.
  const printersQ = useQuery({
    queryKey: ['forge', 'printers'],
    queryFn: fetchPrinters,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const runningQ = useQuery({
    queryKey: ['forge', 'dispatch', 'running'],
    queryFn: () => fetchDispatch('running'),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  const queuedQ = useQuery({
    queryKey: ['forge', 'dispatch', 'queued'],
    queryFn: () => fetchDispatch('queued'),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const isError = printersQ.isError || runningQ.isError || queuedQ.isError;
  const isLoading = printersQ.isLoading || runningQ.isLoading || queuedQ.isLoading;

  if (isError) return <EmptyHint>Failed to load fleet data.</EmptyHint>;
  if (isLoading) return <EmptyHint>Loading fleet…</EmptyHint>;

  const printers = printersQ.data?.printers ?? [];
  const runningJobs = runningQ.data?.jobs ?? [];
  const queuedJobs = queuedQ.data?.jobs ?? [];

  const vms = printers.map((p) => toViewModel(p, runningJobs, queuedJobs));
  const stats = summarise(vms);

  if (vms.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <SectionTitle meta="fleet">Your Fleet</SectionTitle>
        <EmptyHint>No printers registered yet.</EmptyHint>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[1.6px] text-fg-faint mb-1">
            Your Fleet
          </div>
          <h1 className="font-serif italic text-[28px] text-fg leading-[1.1] m-0">
            {stats.total} printer{stats.total === 1 ? '' : 's'}.
          </h1>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            {stats.running > 0 && (
              <>
                <PrinterDot state="running" />
                <span className="font-mono text-[11px] text-fg-faint">{stats.running} printing</span>
              </>
            )}
            {stats.idle > 0 && (
              <span className="font-mono text-[11px] text-fg-faint">
                {stats.running > 0 ? '· ' : ''}{stats.idle} ready
              </span>
            )}
            {stats.disabled > 0 && (
              <span className="font-mono text-[11px] text-fg-faint">
                · {stats.disabled} disabled
              </span>
            )}
          </div>
        </div>

        {/* View-mode toggle */}
        <div className="flex gap-1 p-[3px] bg-surface border border-hairline rounded-md shrink-0">
          <button
            type="button"
            onClick={() => setViewMode('casual')}
            aria-pressed={viewMode === 'casual'}
            className={`font-mono text-[10px] uppercase tracking-[0.8px] px-3 py-[6px] rounded transition-colors ${
              viewMode === 'casual'
                ? 'bg-accent text-accent-ink font-semibold'
                : 'bg-transparent text-fg-faint hover:text-fg'
            }`}
          >
            Casual
          </button>
          <button
            type="button"
            onClick={() => setViewMode('power')}
            aria-pressed={viewMode === 'power'}
            className={`font-mono text-[10px] uppercase tracking-[0.8px] px-3 py-[6px] rounded transition-colors ${
              viewMode === 'power'
                ? 'bg-accent text-accent-ink font-semibold'
                : 'bg-transparent text-fg-faint hover:text-fg'
            }`}
          >
            Power
          </button>
        </div>
      </div>

      {/* Casual grid */}
      {viewMode === 'casual' && (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          {vms.map((vm) => (
            <FleetCard key={vm.id} {...vm} />
          ))}
        </div>
      )}

      {/* Power table */}
      {viewMode === 'power' && (
        <div>
          {/* Summary bar */}
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <MetaBadge tone="neutral">{stats.total} total</MetaBadge>
            {stats.running > 0 && <MetaBadge tone="running">{stats.running} running</MetaBadge>}
            {queuedJobs.length > 0 && (
              <MetaBadge tone="accent">{queuedJobs.length} queued</MetaBadge>
            )}
          </div>

          <div className="rounded-md border border-hairline bg-surface overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-surface-2 border-b border-hairline">
                  <th className="px-[10px] py-2 text-left font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint font-medium" />
                  <th className="px-[10px] py-2 text-left font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint font-medium">Printer</th>
                  <th className="px-[10px] py-2 text-left font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint font-medium">Kind</th>
                  <th className="px-[10px] py-2 text-left font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint font-medium">Via</th>
                  <th className="px-[10px] py-2 text-left font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint font-medium">Status</th>
                  <th className="px-[10px] py-2 text-left font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint font-medium">Progress</th>
                  <th className="px-[10px] py-2 text-left font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint font-medium">Job</th>
                  <th className="px-[10px] py-2 text-left font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint font-medium" />
                </tr>
              </thead>
              <tbody>
                {vms.map((vm) => (
                  <FleetPowerRow key={vm.id} {...vm} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
