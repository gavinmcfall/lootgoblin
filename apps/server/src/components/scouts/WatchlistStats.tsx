// WatchlistStats — 4-tile stat strip for the subscription detail page.
// Canvas variant: SubscriptionDetail stat grid (page-subscriptions.jsx line 147-154).

import { relativeAge } from '@/lib/time';
import { cadenceLabel } from './watchlist-labels';

interface Props {
  firesCount: number;
  lastFiredAt: string | null;
  cadenceSeconds: number;
  errorStreak: number;
}

export function WatchlistStats({ firesCount, lastFiredAt, cadenceSeconds, errorStreak }: Props) {
  // errorStreak is the one stat whose value carries an outcome signal — when
  // > 0, render the value in danger tone per tone-discipline. Other stats are
  // steady-state and stay in fg.
  const stats: { value: string; caption: string; valueClass: string }[] = [
    { value: String(firesCount), caption: 'fires', valueClass: 'text-fg' },
    {
      value: lastFiredAt ? relativeAge(new Date(lastFiredAt)) : '—',
      caption: 'last fire',
      valueClass: 'text-fg',
    },
    { value: cadenceLabel(cadenceSeconds), caption: 'cadence', valueClass: 'text-fg' },
    {
      value: String(errorStreak),
      caption: 'error streak',
      valueClass: errorStreak > 0 ? 'text-danger' : 'text-fg',
    },
  ];

  return (
    <div className="mb-[22px] grid grid-cols-4 gap-3.5">
      {stats.map((s) => (
        <div
          key={s.caption}
          className="rounded-lg border border-hairline bg-surface p-4"
        >
          <div className={`font-serif text-[26px] leading-none tracking-[-0.6px] ${s.valueClass}`}>
            {s.value}
          </div>
          <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.6px] text-fg-faint">
            {s.caption}
          </div>
        </div>
      ))}
    </div>
  );
}
