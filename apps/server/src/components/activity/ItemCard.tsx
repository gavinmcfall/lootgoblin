'use client';
import type { Item } from '@/hooks/useItems';
import { MetaBadge } from '@/components/shell/atoms';

type Tone = 'neutral' | 'running' | 'success' | 'danger';

const STATUS_TONE: Record<Item['status'], Tone> = {
  queued:  'neutral',
  running: 'running',
  done:    'success',
  failed:  'danger',
  skipped: 'neutral',
};

export function ItemCard({ item }: { item: Item }) {
  const snap = item.snapshot ?? {};
  const title = (snap.title as string | undefined) ?? `${item.sourceId}:${item.sourceItemId}`;
  const tone = STATUS_TONE[item.status];

  return (
    <div className="rounded-md border border-hairline bg-surface p-3 hover:bg-surface-hi">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span className="truncate font-sans text-[13.5px] text-fg">{title}</span>
            <MetaBadge tone="neutral">{item.sourceId}</MetaBadge>
            <MetaBadge tone={tone}>{item.status}</MetaBadge>
          </div>
          {item.status === 'running' && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full w-2/5 animate-pulse bg-running" />
            </div>
          )}
          {item.lastError && (
            <div className="mt-1 font-mono text-[10.5px] text-danger">{item.lastError.slice(0, 80)}</div>
          )}
          {item.completedAt && (
            <div className="mt-1 font-mono text-[10.5px] text-fg-faint">
              {new Date(item.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
