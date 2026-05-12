// WatchlistStats — 4-tile stat strip for the subscription detail page.
// Canvas variant: SubscriptionDetail stat grid (page-subscriptions.jsx line 147-154).

import { relativeAge } from '@/lib/time';

interface Props {
  firesCount: number;
  lastFiredAt: string | null;
  cadenceSeconds: number;
  errorStreak: number;
}

function cadenceLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function WatchlistStats({ firesCount, lastFiredAt, cadenceSeconds, errorStreak }: Props) {
  const stats = [
    { value: String(firesCount), caption: 'fires' },
    {
      value: lastFiredAt ? relativeAge(new Date(lastFiredAt)) : '—',
      caption: 'last fire',
    },
    { value: cadenceLabel(cadenceSeconds), caption: 'cadence' },
    { value: String(errorStreak), caption: 'error streak' },
  ];

  return (
    <div className="mb-[22px] grid grid-cols-4 gap-3.5">
      {stats.map((s) => (
        <div
          key={s.caption}
          className="rounded-lg border border-hairline bg-surface p-4"
        >
          <div className="font-serif text-[26px] leading-none tracking-[-0.6px] text-fg">
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
