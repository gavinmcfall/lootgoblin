'use client';
import type { Item } from '@/hooks/useItems';

const STATUS_COLOR: Record<Item['status'], string> = {
  queued: 'border-slate-700',
  running: 'border-emerald-600',
  done: 'border-slate-700',
  failed: 'border-red-600',
  skipped: 'border-slate-700',
};

export function ItemCard({ item }: { item: Item }) {
  const snap = item.snapshot ?? {};
  const title = (snap.title as string | undefined) ?? `${item.sourceId}:${item.sourceItemId}`;
  return (
    <div className={`flex items-center gap-3 rounded-lg border bg-slate-900 p-3 ${STATUS_COLOR[item.status]}`}>
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-slate-800 text-2xl">
        {item.status === 'running' ? '⏳' : item.status === 'done' ? '✅' : item.status === 'failed' ? '❌' : '📦'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-100">{title}</div>
        <div className="mt-0.5 text-xs text-slate-400">
          {item.sourceId} · {item.destinationId ? 'assigned' : 'unassigned'} · {item.status}
          {item.lastError ? ` — ${item.lastError.slice(0, 80)}` : ''}
        </div>
        {item.status === 'running' && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full w-2/5 animate-pulse bg-emerald-500" />
          </div>
        )}
      </div>
      {item.status === 'running' && (
        <div className="text-[11px] text-emerald-300">downloading</div>
      )}
    </div>
  );
}
