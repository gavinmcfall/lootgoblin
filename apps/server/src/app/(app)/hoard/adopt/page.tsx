'use client';
// /hoard/adopt — Library Adoption index.
// Lists stash roots (GET /api/v1/stash-roots) and links each to the wizard at
// /hoard/adopt/{id}. Adoption is keyed on a STASH ROOT, not a hoard library —
// hence /hoard/adopt/{stashRootId}, NOT /hoard/{id}/adopt (that path is the
// destination-edit page).
//
// Creating stash roots is out of scope here (they are registered during setup /
// in settings), so the empty state explains that rather than offering a form.

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { SectionTitle, EmptyHint } from '@/components/shell/atoms';
import type { StashRootsResponse } from '@/components/adoption/types';

export default function AdoptIndexPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['stash-roots'],
    queryFn: async (): Promise<StashRootsResponse> => {
      const res = await fetch('/api/v1/stash-roots?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const roots = data?.items ?? [];

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-baseline gap-3.5">
        <Link
          href="/hoard"
          className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint hover:text-fg-muted"
        >
          Hoard
        </Link>
        <span className="font-mono text-[10px] text-fg-faint">›</span>
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">Adopt</span>
        <span className="flex-1 border-b border-hairline" />
      </div>

      <div>
        <h1 className="m-0 font-serif text-[40px] font-normal leading-[1.02] tracking-[-1.1px] text-fg">
          Adopt existing folders.
        </h1>
        <p className="mt-1.5 font-serif text-[16px] italic text-fg-muted">
          Turn a stash root full of existing model files into a LootGoblin collection — without
          losing data.
        </p>
      </div>

      <SectionTitle meta={`${roots.length} stash root${roots.length === 1 ? '' : 's'}`}>
        Pick a stash root to adopt
      </SectionTitle>

      {isError ? (
        <EmptyHint>Failed to load stash roots. Try refreshing the page.</EmptyHint>
      ) : isLoading ? (
        <EmptyHint>Loading…</EmptyHint>
      ) : roots.length === 0 ? (
        <EmptyHint>
          No stash roots yet. Stash roots are registered during setup or in settings — add one
          there, then come back to adopt its contents.
        </EmptyHint>
      ) : (
        <div className="space-y-2">
          {roots.map((root) => (
            <div
              key={root.id}
              className="group flex items-center rounded-md border border-hairline bg-surface px-4 py-3 transition-colors hover:bg-surface-hi"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-3">
                  <span className="font-serif text-[20px] tracking-[-0.3px] text-fg group-hover:text-accent">
                    {root.name}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-fg-faint">
                  {root.path} · registered {new Date(root.createdAt).toLocaleDateString()}
                </div>
              </div>
              <Link
                href={`/hoard/adopt/${root.id}`}
                className="ml-4 shrink-0 rounded-md bg-accent px-3.5 py-1.5 font-sans text-[12.5px] font-semibold text-accent-ink shadow-sm hover:opacity-90"
              >
                Adopt →
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
