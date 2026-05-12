// LibraryMasthead — large serif library name + KV strip.
// Canvas ref: LDMasthead header row (page-library-detail.jsx lines 182–236).
//
// NOTE: Only the header row (name + blurb + KV strip) is ported. The schema-aware
// lens-tab strip below (By Faction / By Unit / By Variant…) is not rendered
// in the Flat variant — it requires faction/unit/set schema that doesn't exist.
// Those tabs are deferred pending a backend schema-tagging plan.

import { MetaBadge } from '@/components/shell/atoms';

interface Props {
  name: string;
  template: string;
  packager: string;
  count: number;
  blurb?: string | null;
  /** Active tag, shown as a filter chip in the active-state strip below the name. */
  activeTag?: string | null;
}

export function LibraryMasthead({ name, template, packager, count, blurb, activeTag }: Props) {
  return (
    <div className="px-7 pt-5">
      <div className="flex items-end justify-between gap-6">
        <div className="min-w-0">
          {/* eyebrow */}
          <div className="mb-1 flex items-center gap-2.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-accent" />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-accent">
              Library
            </span>
            <span className="font-mono text-[10px] tracking-[1px] text-fg-faint">
              · {template}
            </span>
          </div>

          {/* large serif name */}
          <h1 className="m-0 font-serif text-[48px] font-normal leading-none tracking-[-1.2px] text-fg">
            {name}
            <span className="text-fg-faint">.</span>
          </h1>

          {/* blurb */}
          {blurb && (
            <p className="mt-1.5 max-w-[560px] font-serif italic text-[15px] leading-snug text-fg-muted">
              {blurb}
            </p>
          )}
        </div>

        {/* header meta chips */}
        <div className="flex shrink-0 items-center gap-1.5">
          <MetaBadge tone="neutral">{count.toLocaleString()} models</MetaBadge>
          <MetaBadge tone="neutral">{packager}</MetaBadge>
        </div>
      </div>

      {/* active filter strip — visible only when a tag filter is active */}
      {activeTag && (
        <div className="mt-3 font-mono text-[10.5px] tracking-[0.4px] text-fg-faint">
          filtered by tag:{' '}
          <span className="font-semibold text-accent">#{activeTag}</span>
          {' · '}
          <span className="text-fg-muted">{count.toLocaleString()} models shown</span>
        </div>
      )}

      {/* divider replacing the schema-lens tabs */}
      <div className="mt-4 border-b border-hairline" />
    </div>
  );
}
