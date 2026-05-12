'use client';
// ProvenanceBar — horizontal stacked bar showing 6 provenance classes.
// Canvas ref: ProvenanceBar (page-consumption.jsx line 118–144).
// Used in Analyst view. Vertical variant → ProvenanceStack.

import type { ProvenanceBreakdown } from '@/materials/reports';
import {
  provenanceClassLabel,
  provenanceClassShortLabel,
  provenanceClassCssVar,
  type ProvenanceClass,
} from './reports-labels';

const CLASSES: ProvenanceClass[] = ['measured', 'entered', 'estimated', 'derived', 'computed', 'system'];

interface Props {
  provenance: ProvenanceBreakdown;
}

export function ProvenanceBar({ provenance }: Props) {
  const total =
    provenance.measured + provenance.entered + provenance.estimated +
    provenance.derived + provenance.computed + provenance.system;

  const segs = CLASSES.map((cls) => ({
    cls,
    v: total > 0 ? provenance[cls] / total : 0,
    color: provenanceClassCssVar(cls),
    label: provenanceClassLabel(cls),
  })).filter((s) => s.v > 0);

  const ariaLabel =
    segs.length === 0
      ? 'Provenance breakdown: no data'
      : `Provenance breakdown: ${segs
          .map((s) => `${Math.round(s.v * 100)}% ${provenanceClassShortLabel(s.cls)}`)
          .join(', ')}`;

  return (
    <div
      className="flex items-center gap-4 rounded-md border border-hairline bg-surface px-4 py-3"
      role="img"
      aria-label={ariaLabel}
    >
      <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[1.6px] text-fg-faint">
        Provenance
      </span>
      <div className="flex h-[10px] flex-1 overflow-hidden rounded">
        {segs.map((s) => (
          <div
            key={s.cls}
            title={`${s.label} — ${Math.round(s.v * 100)}%`}
            style={{ width: `${s.v * 100}%`, background: s.color }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {segs.map((s) => (
          <span
            key={s.cls}
            className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.3px] text-fg-muted"
          >
            <span
              className="inline-block h-[7px] w-[7px] rounded-[2px]"
              style={{ background: s.color }}
            />
            {s.label} · {Math.round(s.v * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}
