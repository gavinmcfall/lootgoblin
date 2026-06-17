// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
import { Tile } from '@/components/shell/atoms';

interface Props { queued: number; running: number; done24h: number; failed: number; }

export function StatRow({ queued, running, done24h, failed }: Props) {
  const stats = [
    { label: 'Queued',  value: queued,  color: 'text-fg' },
    { label: 'Running', value: running, color: 'text-running' },
    { label: 'Done 24h', value: done24h, color: 'text-success' },
    { label: 'Failed',  value: failed,  color: 'text-danger' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {stats.map((s) => (
        <Tile key={s.label} className="p-4">
          <div className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">{s.label}</div>
          <div className={`mt-2 font-serif text-[34px] leading-none tracking-[-1px] ${s.color}`}>
            {s.value}
          </div>
        </Tile>
      ))}
    </div>
  );
}
