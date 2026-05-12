'use client';
// GrimoireTable — dense table for the unified Grimoire list.
// Columns: kind chip / name / meta (slicer/printer/material for profiles) / age.
// Canvas reference: GrimoireList (page-grimoire.jsx line 38–102).

import Link from 'next/link';
import { relativeAge } from '@/lib/time';
import { GrimoireBadge } from './GrimoireBadge';
import { slicerKindLabel, printerKindLabel, materialKindLabel } from './grimoire-labels';

interface SlicerProfileRow {
  kind: 'slicer-profile';
  id: string;
  name: string;
  slicerKind: string;
  printerKind: string;
  materialKind: string;
  opaqueUnsupported: boolean;
  createdAt: string;
}

interface PrintSettingRow {
  kind: 'print-setting';
  id: string;
  name: string;
  createdAt: string;
}

type GrimoireRow = SlicerProfileRow | PrintSettingRow;

export function GrimoireTable({ rows }: { rows: GrimoireRow[] }) {
  if (rows.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
      {/* Header */}
      <div
        className="grid items-center gap-3 border-b border-hairline bg-surface-2 px-[14px] py-[10px] font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint"
        style={{ gridTemplateColumns: '120px 1.8fr 1.6fr 90px' }}
      >
        <span>Kind</span>
        <span>Name</span>
        <span>Meta</span>
        <span className="text-right">Age</span>
      </div>

      {rows.map((row, idx) => {
        const isLast = idx === rows.length - 1;
        const href =
          row.kind === 'slicer-profile'
            ? `/grimoire/slicer-profiles/${row.id}`
            : `/grimoire/print-settings/${row.id}`;

        return (
          <Link
            key={`${row.kind}-${row.id}`}
            href={href}
            className={`grid items-center gap-3 px-[14px] py-[10px] text-[12.5px] transition-colors hover:bg-surface-hi ${
              isLast ? '' : 'border-b border-dashed border-hairline'
            }`}
            style={{ gridTemplateColumns: '120px 1.8fr 1.6fr 90px' }}
          >
            {/* Kind chip */}
            <span>
              <GrimoireBadge kind={row.kind} />
            </span>

            {/* Name */}
            <span className="font-sans text-fg">{row.name}</span>

            {/* Meta — slicer profiles show kind chain; print settings show nothing */}
            {row.kind === 'slicer-profile' ? (
              <span className="font-mono text-[10.5px] text-fg-faint">
                {slicerKindLabel(row.slicerKind)}
                {' · '}
                {printerKindLabel(row.printerKind)}
                {' · '}
                {materialKindLabel(row.materialKind)}
              </span>
            ) : (
              <span className="font-mono text-[10.5px] text-fg-faint">—</span>
            )}

            {/* Age */}
            <span className="text-right font-serif text-[12.5px] italic text-fg-muted">
              {relativeAge(new Date(row.createdAt))}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
