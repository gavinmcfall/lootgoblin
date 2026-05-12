'use client';
// ProvenanceStack — vertical stacked provenance bar + legend.
// Canvas ref: ProvenanceStack (page-consumption.jsx line 359–380).
// Used in Story view sidebar.

import type { ProvenanceBreakdown } from '@/materials/reports';
import {
  provenanceClassShortLabel,
  provenanceClassCssVar,
  type ProvenanceClass,
} from './reports-labels';

const CLASSES: ProvenanceClass[] = ['measured', 'entered', 'estimated', 'derived', 'computed', 'system'];

interface Props {
  provenance: ProvenanceBreakdown;
}

export function ProvenanceStack({ provenance }: Props) {
  const total =
    provenance.measured + provenance.entered + provenance.estimated +
    provenance.derived + provenance.computed + provenance.system;

  const segs = CLASSES.map((cls) => ({
    cls,
    v: total > 0 ? provenance[cls] / total : 0,
    color: provenanceClassCssVar(cls),
    label: provenanceClassShortLabel(cls),
  })).filter((s) => s.v > 0);

  return (
    <div>
      <div className="flex h-[10px] overflow-hidden rounded">
        {segs.map((s) => (
          <div
            key={s.cls}
            title={`${s.label} — ${Math.round(s.v * 100)}%`}
            style={{ width: `${s.v * 100}%`, background: s.color }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-y-1">
        {segs.map((s) => (
          <span
            key={s.cls}
            className="flex items-center gap-1 font-mono text-[10px] text-fg-muted"
          >
            <span
              className="inline-block h-[7px] w-[7px] rounded-[2px]"
              style={{ background: s.color }}
            />
            {s.label} {Math.round(s.v * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}
