// LibraryLootCard — single loot card in the flat browse grid.
// Canvas ref: flat card grid (page-library-detail.jsx lines 585–609).

import Link from 'next/link';
import { MetaBadge } from '@/components/shell/atoms';

interface Props {
  id: string;
  title: string;
  creator: string | null;
  tags: string[];
  fileMissing: boolean;
  /** The tag currently active as a filter — highlighted in accent tone. */
  activeTag: string | null;
}

export function LibraryLootCard({ id, title, creator, tags, fileMissing, activeTag }: Props) {
  return (
    <Link
      href={`/loot/${id}`}
      className={[
        'group flex flex-col overflow-hidden rounded-md border border-hairline bg-surface transition-colors hover:bg-surface-hi',
        fileMissing ? 'opacity-55' : '',
      ].join(' ')}
    >
      {/* thumbnail */}
      <div className="relative aspect-square overflow-hidden bg-surface-2">
        <img
          src={`/api/v1/loot/${id}/thumbnail`}
          alt={title}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(e) => {
            const el = e.currentTarget;
            el.style.display = 'none';
            const placeholder = el.nextElementSibling as HTMLElement | null;
            if (placeholder) placeholder.style.display = 'flex';
          }}
        />
        {/* fallback placeholder — hidden until img errors */}
        <div
          aria-hidden="true"
          style={{ display: 'none' }}
          className="absolute inset-0 flex items-center justify-center bg-surface-2"
        >
          <span className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">
            no preview
          </span>
        </div>

        {/* file-missing badge */}
        {fileMissing && (
          <div className="absolute bottom-0 left-0 right-0 bg-surface-2/80 px-2 py-0.5 text-center font-mono text-[8.5px] italic text-fg-faint backdrop-blur-sm">
            file missing
          </div>
        )}
      </div>

      {/* card body */}
      <div className="flex flex-col gap-1.5 px-2.5 py-2">
        <div className={['font-sans text-[12px] font-semibold leading-snug text-fg', fileMissing ? 'italic' : ''].join(' ')}>
          {title}
        </div>

        {creator && (
          <div className="font-mono text-[9.5px] text-fg-faint">
            {creator}
          </div>
        )}

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.slice(0, 5).map((tag) => (
              <MetaBadge key={tag} tone={tag === activeTag ? 'accent' : 'neutral'}>
                #{tag}
              </MetaBadge>
            ))}
            {tags.length > 5 && (
              <span className="font-mono text-[9px] text-fg-faint">+{tags.length - 5}</span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}
