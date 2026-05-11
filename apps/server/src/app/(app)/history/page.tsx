'use client';
import { useItems } from '@/hooks/useItems';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { SectionTitle, MetaBadge, EmptyHint } from '@/components/shell/atoms';
import { relativeAge, localDayKey } from '@/lib/time';

export default function HistoryPage() {
  const { data, isLoading } = useItems();
  const qc = useQueryClient();
  const items = (data?.items ?? []).filter(
    (i) => i.status === 'done' || i.status === 'failed' || i.status === 'skipped',
  );

  async function retry(id: string, sourceId: string, sourceItemId: string, sourceUrl: string) {
    const res = await fetch('/api/v1/stash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId,
        sourceItemId,
        sourceUrl,
        contentType: 'model-3d',
        force: true,
      }),
    });
    if (res.ok) {
      toast.success('Re-queued');
      qc.invalidateQueries({ queryKey: ['items'] });
    } else {
      toast.error('Retry failed');
    }
  }

  if (isLoading) {
    return <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>;
  }
  if (items.length === 0) {
    return <EmptyHint>No history yet. The Ledger awaits the goblin&apos;s first move.</EmptyHint>;
  }

  // group by day
  const groups: Record<string, typeof items> = {};
  for (const it of items) {
    const at = it.completedAt ? new Date(it.completedAt) : new Date(it.createdAt);
    const k = localDayKey(at);
    (groups[k] ??= []).push(it);
  }
  const dayKeys = Object.keys(groups).sort().reverse();

  return (
    <div className="space-y-8">
      {dayKeys.map((k) => (
        <section key={k}>
          <SectionTitle as="h3" meta={`${groups[k]!.length} events`}>
            {new Date(`${k}T12:00:00Z`).toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            })}
          </SectionTitle>
          <div>
            {groups[k]!.map((it) => {
              const at = it.completedAt ? new Date(it.completedAt) : new Date(it.createdAt);
              const snap = (it.snapshot ?? {}) as Record<string, unknown>;
              const title = (snap.title as string | undefined) ?? `${it.sourceId}:${it.sourceItemId}`;
              const tone = it.status === 'done' ? 'success' : it.status === 'failed' ? 'danger' : 'neutral';
              return (
                <div
                  key={it.id}
                  className="flex items-baseline gap-3 border-b border-hairline py-2.5 last:border-b-0"
                >
                  <span className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">
                    {relativeAge(at)}
                  </span>
                  <MetaBadge tone={tone}>{it.status}</MetaBadge>
                  <span className="flex-1 truncate text-[13px] text-fg">{title}</span>
                  {it.status === 'failed' ? (
                    <button
                      type="button"
                      onClick={() => retry(it.id, it.sourceId, it.sourceItemId, it.sourceUrl)}
                      className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint hover:text-accent"
                    >
                      retry
                    </button>
                  ) : (
                    <span
                      className="font-mono text-[10px] tracking-[1px] text-fg-ghost"
                      aria-hidden="true"
                    >
                      —
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
