// LibraryBreadcrumb — breadcrumb bar for the library browse view.
// Canvas ref: LDBreadcrumb (page-library-detail.jsx lines 80–112).
// Used by /hoard/[id]/browse (Flat variant). Overview/Drilled/Partial deferred.

import type { ReactNode } from 'react';
import Link from 'next/link';

interface Props {
  libraryName: string;
  /** Active tag filter, if any. */
  activeTag?: string | null;
  /** Content to render in the right slot. */
  right?: ReactNode;
}

export function LibraryBreadcrumb({ libraryName, activeTag, right }: Props) {
  return (
    <div className="flex items-center gap-2 border-b border-hairline bg-surface px-6 py-2.5 font-mono text-[10.5px] tracking-[0.3px] text-fg-faint">
      <Link
        href="/hoard"
        className="font-mono text-[10px] uppercase tracking-[1.4px] text-fg-faint hover:text-fg"
      >
        Hoard
      </Link>
      <span className="text-fg-faint">›</span>
      <span className="font-semibold tracking-[0.4px] text-accent">
        {libraryName}
      </span>
      {activeTag && (
        <>
          <span className="text-fg-faint">›</span>
          <span className="rounded-sm bg-accent-soft px-1.5 py-px font-mono text-[10px] font-semibold text-accent">
            #{activeTag}
          </span>
        </>
      )}
      <span className="ml-auto">{right}</span>
    </div>
  );
}
