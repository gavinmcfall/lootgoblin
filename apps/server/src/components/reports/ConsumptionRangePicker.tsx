// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// ConsumptionRangePicker — 3-preset time-window selector.
// Canvas ref: ConsRangePicker (page-consumption.jsx line 101–116).
// Presets: 30d / 90d / 365d. Active state: bg-accent-soft text-accent.

import { RANGE_PRESETS, type RangePreset } from './reports-labels';

interface Props {
  value: RangePreset;
  onChange: (v: RangePreset) => void;
}

export function ConsumptionRangePicker({ value, onChange }: Props) {
  return (
    <div
      className="flex gap-1 rounded-full border border-hairline bg-surface-2 p-[3px]"
      role="group"
      aria-label="Time range"
    >
      {RANGE_PRESETS.map((p) => {
        const active = value === p.key;
        return (
          <button
            key={p.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(p.key)}
            className={`rounded-full border px-[10px] py-1 font-mono text-[10px] tracking-[0.4px] transition-colors ${
              active
                ? 'border-hairline bg-surface text-fg'
                : 'border-transparent bg-transparent text-fg-muted hover:text-fg'
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
