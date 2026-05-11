'use client';
import { useItems } from '@/hooks/useItems';
import { ItemCard } from '@/components/activity/ItemCard';
import { StatRow } from '@/components/activity/StatRow';
import { GoButton } from '@/components/activity/GoButton';
import { SectionTitle, EmptyHint } from '@/components/shell/atoms';

export default function ActivityPage() {
  const { data, isLoading } = useItems();
  if (isLoading) return <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>;
  const items = data?.items ?? [];
  const running = items.filter((i) => i.status === 'running');
  const queued = items.filter((i) => i.status === 'queued');
  const done24h = items.filter(
    (i) => i.status === 'done' && i.completedAt && new Date(i.completedAt).getTime() > Date.now() - 86_400_000,
  );
  const failed = items.filter((i) => i.status === 'failed').length;

  return (
    <div className="space-y-8">
      <StatRow queued={queued.length} running={running.length} done24h={done24h.length} failed={failed} />

      <section>
        <SectionTitle meta={`${running.length} active`} right={<GoButton count={queued.length} />}>
          Running
        </SectionTitle>
        {running.length === 0 ? (
          <EmptyHint>Nothing on the rack. The goblin waits.</EmptyHint>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {running.map((i) => <ItemCard key={i.id} item={i} />)}
          </div>
        )}
      </section>

      <section>
        <SectionTitle meta={`${done24h.length} in last 24h`}>Recent loot</SectionTitle>
        {done24h.length === 0 ? (
          <EmptyHint>No loot today yet.</EmptyHint>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {done24h.slice(0, 12).map((i) => <ItemCard key={i.id} item={i} />)}
          </div>
        )}
      </section>
    </div>
  );
}
