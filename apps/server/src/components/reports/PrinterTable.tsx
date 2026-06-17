// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// PrinterTable — table of printers with kg / events / share%.
// Canvas ref: PrinterTable (page-consumption.jsx line 214–238).
// "share" rendered as an accent mini-bar. eventCount used for prints col.

interface PrinterDatum {
  name: string;
  /** Total mass in kg */
  mass: number;
  /** Number of print events */
  prints: number;
  /** Share fraction 0–1 */
  share: number;
}

interface Props {
  data: PrinterDatum[];
}

export function PrinterTable({ data }: Props) {
  return (
    <div className="flex flex-col">
      {/* Header */}
      <div
        className="grid gap-[10px] border-b border-hairline py-1.5 font-mono text-[9.5px] uppercase tracking-[0.7px] text-fg-faint"
        style={{ gridTemplateColumns: '1.4fr 70px 60px 1fr' }}
      >
        <span>Printer</span>
        <span className="text-right">kg</span>
        <span className="text-right">prints</span>
        <span>share</span>
      </div>
      {data.map((p) => (
        <div
          key={p.name}
          className="grid items-center gap-[10px] border-b border-dashed border-hairline py-[10px] text-[12px]"
          style={{ gridTemplateColumns: '1.4fr 70px 60px 1fr' }}
        >
          <span className="font-sans text-fg">{p.name}</span>
          <span className="text-right font-mono text-[11px] text-fg">{p.mass.toFixed(2)}</span>
          <span className="text-right font-mono text-[11px] text-fg-muted">{p.prints}</span>
          <div className="h-[6px] overflow-hidden rounded-[3px] bg-surface-2">
            <div
              className="h-full bg-accent"
              style={{ width: `${p.share * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
