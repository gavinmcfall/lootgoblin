// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// LibraryTagCloud — left rail tag cloud for the Flat library browse view.
// Canvas ref: LDFacetRail flat subset (page-library-detail.jsx lines 115–182,
// specifically the tag-cloud variant rendered in LibraryDetailFlat, lines 531–563).
//
// NOTE: Tree-mode facet rail (for Overview/Drilled variants with faction/unit hierarchy)
// is deferred — those variants require a backend schema-tagging plan before they can
// be built. Only the tag-cloud subset is implemented here.

interface TagCount {
  tag: string;
  count: number;
}

interface Props {
  libraryName: string;
  tags: TagCount[];
  activeTag: string | null;
  onTagClick: (tag: string) => void;
  lootCount: number;
  librarySize?: string | null;
  lastAdded?: string | null;
}

export function LibraryTagCloud({
  libraryName,
  tags,
  activeTag,
  onTagClick,
  lootCount,
  librarySize,
  lastAdded,
}: Props) {
  return (
    <aside className="w-60 shrink-0 overflow-auto border-r border-hairline bg-surface py-4">
      {/* axes header */}
      <div className="px-4 pb-3">
        <div className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
          this library's axes
        </div>
        <div className="font-mono text-[10.5px] leading-relaxed text-fg-muted">
          <span className="font-semibold text-accent">tags</span>
          <span className="text-fg-faint"> · </span>
          <span className="font-semibold text-accent">author</span>
          <span className="text-fg-faint"> · </span>
          <span className="font-semibold text-accent">date</span>
        </div>
        <div className="mt-2 font-serif italic text-[11.5px] leading-snug text-fg-faint">
          no hierarchy — search is the navigation.
        </div>
      </div>

      {/* tag cloud */}
      <div className="px-3 py-2">
        <div className="mb-2 px-1 font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint">
          tag cloud
        </div>
        {/* TODO: future — GET /api/v1/loot/tags-by-collection?collectionId=<id>
            for large libraries where client-side aggregation won't scale. */}
        <div className="flex flex-wrap gap-1.5">
          {tags.map(({ tag, count }) => {
            const isActive = tag === activeTag;
            // Scale font size logarithmically by count (10–16px range)
            const fontSize = Math.max(10, Math.min(16, 10 + Math.log2(Math.max(1, count)) * 0.8));
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onTagClick(tag)}
                aria-pressed={isActive}
                style={{ fontSize }}
                className={[
                  'rounded-sm border px-1.5 py-0.5 font-mono tracking-[0.3px] transition-colors',
                  isActive
                    ? 'border-accent bg-accent-soft font-bold text-accent'
                    : 'border-transparent bg-transparent font-medium text-fg-muted hover:border-hairline hover:text-fg',
                ].join(' ')}
              >
                #{tag}
                <span className="ml-1 text-[9px] font-normal text-fg-faint">{count}</span>
              </button>
            );
          })}
          {tags.length === 0 && (
            <span className="font-mono text-[10px] italic text-fg-faint">no tags yet</span>
          )}
        </div>
      </div>

      {/* library meta footer */}
      <div className="mt-3.5 border-t border-dashed border-hairline px-4 pt-4">
        <div className="mb-2 font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint">
          library
        </div>
        <div className="font-mono text-[10.5px] leading-[1.7] text-fg-muted">
          {lootCount.toLocaleString()} models
          {librarySize && (
            <>
              <br />
              {librarySize}
            </>
          )}
          {lastAdded && (
            <>
              <br />
              last added {lastAdded}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
