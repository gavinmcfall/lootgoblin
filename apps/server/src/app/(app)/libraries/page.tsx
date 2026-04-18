'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

interface Destination {
  id: string;
  name: string;
  type: string;
  config: { path: string; namingTemplate: string };
  packager: string;
}

export default function LibrariesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['destinations'],
    queryFn: async (): Promise<{ destinations: Destination[] }> => (await fetch('/api/v1/destinations')).json(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-100">Libraries</h2>
        <Link href="/libraries/new" className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500">
          + New library
        </Link>
      </div>
      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (data?.destinations.length ?? 0) === 0 ? (
        <p className="text-sm text-slate-500">No libraries yet. Create one to get started.</p>
      ) : (
        <div className="space-y-2">
          {data!.destinations.map((d) => (
            <Link
              key={d.id}
              href={`/libraries/${d.id}`}
              className="block rounded-lg border border-slate-700 bg-slate-900 p-3 hover:border-slate-600"
            >
              <div className="text-sm font-medium text-slate-100">{d.name}</div>
              <div className="mt-0.5 font-mono text-xs text-slate-400">
                {d.config.path} · {d.config.namingTemplate} · {d.packager}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
