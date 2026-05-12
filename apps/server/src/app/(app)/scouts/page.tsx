'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CredentialList } from '@/components/scouts/CredentialList';
import { SectionTitle, EmptyHint, MetaBadge } from '@/components/shell/atoms';

interface SourceCapabilities {
  id: string;
  displayName: string;
  triggerModes: string[];
  contentTypes: string[];
  authKind: string;
  defaultRateLimitPerSec: number;
}

export default function ScoutsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['sources'],
    queryFn: async (): Promise<{ sources: SourceCapabilities[] }> =>
      (await fetch('/api/v1/scouts')).json(),
  });

  if (isLoading) {
    return <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>;
  }

  const sources = data?.sources ?? [];

  return (
    <div className="space-y-8">
      {/* Watchlist discovery link — sits under Scouts (breadcrumb: Scouts › Watchlist) */}
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">Watchlist</span>
        <Link
          href="/scouts/watchlist"
          className="font-mono text-[10px] uppercase tracking-[0.6px] text-accent hover:underline"
        >
          Watchlist →
        </Link>
      </div>
      <SectionTitle meta={`${sources.length} adapters`}>Scout adapters &amp; credentials</SectionTitle>
      <p className="max-w-2xl font-serif text-[14px] italic text-fg-faint">
        These are the sources the goblin can scout. Each adapter holds its credentials below;
        Roster / Dispatch / Rules views land in a future plan.
      </p>
      {sources.length === 0 ? (
        <EmptyHint>No scout adapters registered.</EmptyHint>
      ) : (
        <div className="space-y-6">
          {sources.map((s) => (
            <section key={s.id}>
              <div className="mb-3 flex items-baseline gap-3">
                <h3 className="m-0 font-serif text-[18px] tracking-[-0.3px] text-fg">{s.displayName}</h3>
                <MetaBadge tone="neutral">{s.authKind}</MetaBadge>
                <span className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">
                  {s.triggerModes.join(' · ')}
                </span>
              </div>
              <CredentialList sourceId={s.id} authKind={s.authKind} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
