'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { SectionTitle, EmptyHint, MetaBadge } from '@/components/shell/atoms';

interface Destination {
  id: string;
  name: string;
  type: string;
  config: { path: string; namingTemplate: string };
  packager: string;
}

export default function HoardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['destinations'],
    queryFn: async (): Promise<{ destinations: Destination[] }> =>
      (await fetch('/api/v1/hoard')).json(),
  });
  const libraries = data?.destinations ?? [];
  return (
    <div className="space-y-6">
      <SectionTitle
        meta={`${libraries.length} librar${libraries.length === 1 ? 'y' : 'ies'}`}
        right={
          <Link
            href="/hoard/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink shadow-sm hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} /> New library
          </Link>
        }
      >
        Libraries in the hoard
      </SectionTitle>
      {isLoading ? (
        <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>
      ) : libraries.length === 0 ? (
        <EmptyHint>
          The hoard is empty. Start by creating a library — every Loot lives in one.
        </EmptyHint>
      ) : (
        <div className="space-y-2">
          {libraries.map((d) => (
            <Link
              key={d.id}
              href={`/hoard/${d.id}`}
              className="group block rounded-md border border-hairline bg-surface px-4 py-3 transition-colors hover:bg-surface-hi"
            >
              <div className="flex items-baseline gap-3">
                <span className="font-serif text-[20px] tracking-[-0.3px] text-fg group-hover:text-accent">
                  {d.name}
                </span>
                <MetaBadge tone="neutral">{d.packager}</MetaBadge>
              </div>
              <div className="mt-1 font-mono text-[11px] text-fg-faint">
                {d.config.path} · {d.config.namingTemplate}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
