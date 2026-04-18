'use client';
import { useItems } from '@/hooks/useItems';
import { ItemCard } from '@/components/activity/ItemCard';
import { StatRow } from '@/components/activity/StatRow';
import { GoButton } from '@/components/activity/GoButton';

export default function ActivityPage() {
  const { data, isLoading } = useItems();
  if (isLoading) return <p className="text-slate-400">Loading…</p>;
  const items = data?.items ?? [];
  const running = items.filter((i) => i.status === 'running');
  const queued = items.filter((i) => i.status === 'queued');
  const done24h = items.filter((i) => i.status === 'done' && i.completedAt && new Date(i.completedAt).getTime() > Date.now() - 86_400_000).length;
  const failed = items.filter((i) => i.status === 'failed').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">Activity</h2>
          <p className="text-sm text-slate-400">{queued.length} queued · {running.length} running · {done24h} completed in 24h</p>
        </div>
        <GoButton count={queued.length} />
      </div>

      <StatRow queued={queued.length} running={running.length} done24h={done24h} failed={failed} />

      <section>
        <h3 className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Running</h3>
        {running.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing running.</p>
        ) : (
          <div className="space-y-2">{running.map((i) => <ItemCard key={i.id} item={i} />)}</div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Queued · {queued.length}</h3>
        {queued.length === 0 ? (
          <p className="text-sm text-slate-500">Queue is empty.</p>
        ) : (
          <div className="space-y-2">{queued.map((i) => <ItemCard key={i.id} item={i} />)}</div>
        )}
      </section>
    </div>
  );
}
