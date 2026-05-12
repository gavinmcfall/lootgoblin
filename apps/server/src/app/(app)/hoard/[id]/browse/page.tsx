'use client';
// /hoard/[id]/browse — Library detail browse view, Flat variant.
// Canvas ref: LibraryDetailFlat (page-library-detail.jsx lines 497–616).
// Canvas-port #10 in the autonomous-shipment roadmap.
//
// TODO (deferred — design-needed list):
//   Overview, Drilled, and Partial variants of the library detail view all require
//   a backend faction/unit/set organisational schema that doesn't exist yet.
//   They cannot be built schema-less. Stakeholder will decide whether to redesign
//   the variants without schema, or commission a backend schema-tagging plan before
//   those are added here.

import { use, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { EmptyHint } from '@/components/shell/atoms';
import { LibraryBreadcrumb } from '@/components/hoard/LibraryBreadcrumb';
import { LibraryMasthead } from '@/components/hoard/LibraryMasthead';
import { LibraryTagCloud } from '@/components/hoard/LibraryTagCloud';
import { LibraryLootCard } from '@/components/hoard/LibraryLootCard';

// ── DTO types ─────────────────────────────────────────────────────────────────

interface HoardLibrary {
  id: string;
  name: string;
  config: { path: string; namingTemplate: string };
  packager: string;
  credentialId?: string;
}

interface LootItem {
  id: string;
  collectionId: string;
  title: string;
  description: string | null;
  tags: string[];
  creator: string | null;
  license: string | null;
  sourceItemId: string | null;
  contentSummary: unknown | null;
  fileMissing: boolean;
  parentLootId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── fetch helpers ─────────────────────────────────────────────────────────────

async function fetchLibrary(id: string): Promise<HoardLibrary> {
  const res = await fetch(`/api/v1/hoard/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  // API returns { hoardLibrary: row }
  return body.hoardLibrary as HoardLibrary;
}

async function fetchLoot(collectionId: string): Promise<LootItem[]> {
  // Fetch up to 100 items per page. Tag aggregation is done client-side from
  // the full list.
  // TODO: future — paginate via offset once libraries grow large. A dedicated
  // GET /api/v1/loot/tags-by-collection?collectionId=<id> aggregation endpoint
  // should be added for large libraries where client-side aggregation won't scale.
  const res = await fetch(`/api/v1/loot?collectionId=${encodeURIComponent(collectionId)}&limit=100&offset=0`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body.items ?? []) as LootItem[];
}

// ── tag aggregation ────────────────────────────────────────────────────────────

function aggregateTags(items: LootItem[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function LibraryBrowsePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();

  const activeTag = searchParams.get('tag');

  // Library query — rarely changes
  const libraryQuery = useQuery({
    queryKey: ['hoard', id],
    queryFn: () => fetchLibrary(id),
    staleTime: 30_000,
  });

  // Loot query — keyed by collection only; tag filter is applied client-side
  // below so we don't want a new cache entry / refetch per tag change.
  const lootQuery = useQuery({
    queryKey: ['loot', { collectionId: id }],
    queryFn: () => fetchLoot(id),
    staleTime: 5_000,
  });

  // Tag click: update URL param so filter is bookmarkable + back-button-friendly
  const handleTagClick = useCallback(
    (tag: string) => {
      const next = new URLSearchParams(searchParams.toString());
      if (next.get('tag') === tag) {
        next.delete('tag');
      } else {
        next.set('tag', tag);
      }
      router.replace(`/hoard/${id}/browse?${next.toString()}`);
    },
    [id, router, searchParams],
  );

  const clearTag = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete('tag');
    router.replace(`/hoard/${id}/browse?${next.toString()}`);
  }, [id, router, searchParams]);

  // Error states first (carry-forward rule #1)
  if (libraryQuery.isError) {
    return (
      <div className="space-y-4">
        <EmptyHint>
          Failed to load this library. It may have been deleted or you may not have permission.
        </EmptyHint>
        <Link
          href="/hoard"
          className="font-mono text-[11px] uppercase tracking-[1px] text-accent hover:underline"
        >
          ← Back to hoard
        </Link>
      </div>
    );
  }

  if (libraryQuery.isLoading || !libraryQuery.data) {
    return <EmptyHint>Loading…</EmptyHint>;
  }

  const library = libraryQuery.data;

  // Compute tag cloud from full loot list — memoized so parent re-renders
  // (URL changes, hover state, etc.) don't re-run the O(N×tags) aggregation.
  const allItems = lootQuery.data ?? [];
  const tagCounts = useMemo(() => aggregateTags(allItems), [allItems]);

  // Apply active tag filter in the grid
  const visibleItems = activeTag
    ? allItems.filter((item) => item.tags?.includes(activeTag))
    : allItems;

  // Breadcrumb right slot
  const breadcrumbRight = (
    <span className="font-mono text-[10px] text-fg-faint">
      {allItems.length.toLocaleString()} models
    </span>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Breadcrumb */}
      <LibraryBreadcrumb
        libraryName={library.name}
        activeTag={activeTag}
        right={
          <div className="flex items-center gap-3">
            {activeTag && (
              <button
                type="button"
                onClick={clearTag}
                className="font-mono text-[10px] text-accent hover:underline"
              >
                × clear filter
              </button>
            )}
            {breadcrumbRight}
          </div>
        }
      />

      {/* Body — tag rail + main content */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left tag cloud rail */}
        <LibraryTagCloud
          libraryName={library.name}
          tags={tagCounts}
          activeTag={activeTag}
          onTagClick={handleTagClick}
          lootCount={allItems.length}
        />

        {/* Main area */}
        <main className="flex-1 overflow-auto bg-bg px-7 pb-7 pt-0">
          {/* Masthead */}
          <LibraryMasthead
            name={library.name}
            template={library.config?.namingTemplate ?? 'flat · tag-indexed'}
            packager={library.packager}
            count={visibleItems.length}
            activeTag={activeTag}
          />

          {/* Loot grid */}
          <div className="mt-5">
            {lootQuery.isError ? (
              <EmptyHint>Failed to load models. Try refreshing the page.</EmptyHint>
            ) : lootQuery.isLoading ? (
              <EmptyHint>Loading…</EmptyHint>
            ) : visibleItems.length === 0 ? (
              <EmptyHint>
                {activeTag
                  ? `No models tagged #${activeTag} in this library.`
                  : 'This library is empty. Send a Scout here or upload models directly.'}
              </EmptyHint>
            ) : (
              <>
                {/* result count strip */}
                <div className="mb-3 font-mono text-[10.5px] tracking-[0.4px] text-fg-faint">
                  {visibleItems.length.toLocaleString()} model{visibleItems.length === 1 ? '' : 's'}
                  {activeTag && (
                    <>
                      {' · '}
                      tag:{' '}
                      <span className="font-semibold text-accent">#{activeTag}</span>
                    </>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {visibleItems.map((item) => (
                    <LibraryLootCard
                      key={item.id}
                      id={item.id}
                      title={item.title}
                      creator={item.creator}
                      tags={item.tags ?? []}
                      fileMissing={item.fileMissing}
                      activeTag={activeTag}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
