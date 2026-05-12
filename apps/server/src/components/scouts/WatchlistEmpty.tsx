// WatchlistEmpty — 3-suggested-seed empty state for the watchlist.
// Canvas variant: SubscriptionEmpty (page-subscriptions.jsx line 198-222).

import Link from 'next/link';
import { WatchKindChip } from './WatchKindChip';

const SEEDS = [
  { kind: 'creator', label: 'A favourite designer', sub: 'paste their profile URL' },
  { kind: 'tag', label: 'A specific tag', sub: '#mk-vi · #necron · #functional' },
  { kind: 'saved_search', label: 'A saved search', sub: 'keyword or phrase to track' },
];

export function WatchlistEmpty() {
  return (
    <div className="px-10 py-[60px] text-center">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
        Watchlist · empty
      </div>
      <h1 className="m-0 font-serif text-[56px] font-normal leading-none tracking-[-1.6px] text-fg">
        Nothing watched yet.
      </h1>
      <p className="mx-auto mt-[14px] max-w-[580px] font-serif text-[17px] italic text-fg-muted">
        Watches are how the goblin earns its keep — paste a creator URL or a tag,
        and we&apos;ll go check on it for you on a schedule.
      </p>
      <div className="mx-auto mt-9 grid max-w-[720px] grid-cols-3 gap-3.5">
        {SEEDS.map((s) => (
          <div
            key={s.kind}
            className="rounded-lg border border-hairline bg-surface p-[18px] text-left"
          >
            <WatchKindChip kind={s.kind} />
            <div className="mt-2 font-serif text-[16px] tracking-[-0.2px] text-fg">{s.label}</div>
            <div className="mt-1 font-serif text-[12.5px] italic text-fg-muted">{s.sub}</div>
          </div>
        ))}
      </div>
      <Link
        href="/scouts/watchlist/new"
        className="mt-7 inline-block rounded-md bg-accent px-[18px] py-[10px] text-[13px] font-semibold text-accent-ink"
      >
        + Add your first watch
      </Link>
    </div>
  );
}
