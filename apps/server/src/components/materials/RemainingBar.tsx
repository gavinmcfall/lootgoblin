// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// RemainingBar — small progress bar showing remainingAmount / initialAmount.
// Color semantics: > 50% → bg-success, 20-50% → bg-running, < 20% → bg-danger.
// Numeric label stays text-fg (steady-state, not an outcome).

interface RemainingBarProps {
  remainingAmount: number;
  initialAmount: number;
  unit: string;
  showLabel?: boolean;
}

export function RemainingBar({
  remainingAmount,
  initialAmount,
  unit,
  showLabel = true,
}: RemainingBarProps) {
  const pct =
    initialAmount === 0
      ? 0
      : Math.min(100, Math.round((remainingAmount / initialAmount) * 100));

  const fillClass =
    pct > 50 ? 'bg-success' : pct >= 20 ? 'bg-running' : 'bg-danger';

  return (
    <div>
      {showLabel && (
        <div className="mb-1 flex items-baseline gap-1.5">
          <span className="font-mono text-[12px] text-fg">
            {remainingAmount}
          </span>
          <span className="font-mono text-[10px] text-fg-faint">
            /{initialAmount}{unit}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Remaining"
        className="h-[3px] w-full overflow-hidden rounded-sm bg-surface-2"
      >
        <div
          className={`h-full rounded-sm ${fillClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
