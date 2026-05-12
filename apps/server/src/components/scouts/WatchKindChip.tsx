// WatchKindChip — small mono chip mapping subscription kind → display label.
// Canvas variant: WatchKindChip (page-subscriptions.jsx line 17-19).
// Maps the 5 backend kinds to short display labels (canvas knew 3; backend has 5).

import { kindLabel } from './watchlist-labels';

export function WatchKindChip({ kind }: { kind: string }) {
  const label = kindLabel(kind);
  return (
    <span className="inline-block rounded-[3px] border border-hairline px-[7px] py-[2px] font-mono text-[9px] uppercase tracking-[0.6px] text-fg-faint">
      {label}
    </span>
  );
}
