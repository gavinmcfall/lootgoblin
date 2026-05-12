'use client';
// SearchGroupHeader — section header with mono uppercase label + optional count.
// Canvas reference: CKGroupHeader (page-search-palette.jsx line 64–77).

interface SearchGroupHeaderProps {
  label: string;
  count?: number;
}

export function SearchGroupHeader({ label, count }: SearchGroupHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-4 pb-1 pt-2">
      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[1.6px] text-fg-faint">
        {label}
      </span>
      {count != null && (
        <span className="font-mono text-[9.5px] font-normal text-fg-faint">
          · {count}
        </span>
      )}
      <span className="ml-1 flex-1 border-b border-dashed border-hairline" />
    </div>
  );
}
