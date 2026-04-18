'use client';
import { useQuery } from '@tanstack/react-query';
import { CredentialList } from '@/components/sources/CredentialList';

interface SourceCapabilities {
  id: string;
  displayName: string;
  triggerModes: string[];
  contentTypes: string[];
  authKind: string;
  defaultRateLimitPerSec: number;
}

export default function SourcesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['sources'],
    queryFn: async (): Promise<{ sources: SourceCapabilities[] }> =>
      (await fetch('/api/v1/sources')).json(),
  });

  if (isLoading) return <p className="text-sm text-slate-400">Loading…</p>;
  const sources = data?.sources ?? [];

  return (
    <div className="space-y-8">
      <h2 className="text-xl font-semibold text-slate-100">Sources</h2>

      {sources.length === 0 ? (
        <p className="text-sm text-slate-500">No sources registered.</p>
      ) : (
        sources.map((s) => (
          <section key={s.id} className="space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div>
                <h3 className="text-base font-medium text-slate-100">{s.displayName}</h3>
                <p className="text-xs text-slate-500">
                  {s.id} · {s.authKind} · {s.triggerModes.join(', ')} · {s.contentTypes.join(', ')}
                </p>
              </div>
            </div>
            <CredentialList sourceId={s.id} />
          </section>
        ))
      )}
    </div>
  );
}
