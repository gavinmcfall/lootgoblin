// Shared label helpers for Reports UI.

import type { ProvenanceBreakdown } from '@/materials/reports';

export type ProvenanceClass = keyof ProvenanceBreakdown;

/** Human-readable label for a provenance class. */
export function provenanceClassLabel(cls: ProvenanceClass): string {
  switch (cls) {
    case 'measured':  return 'measured · scale';
    case 'entered':   return 'entered · by hand';
    case 'estimated': return 'estimated · slicer';
    case 'derived':   return 'derived · inferred';
    case 'computed':  return 'computed · auto';
    case 'system':    return 'system · generated';
  }
}

/** Short label for provenance class (used in compact legends). */
export function provenanceClassShortLabel(cls: ProvenanceClass): string {
  switch (cls) {
    case 'measured':  return 'measured';
    case 'entered':   return 'entered';
    case 'estimated': return 'estimated';
    case 'derived':   return 'derived';
    case 'computed':  return 'computed';
    case 'system':    return 'system';
  }
}

/** Tailwind classes for provenance class color (bar fill + legend swatch). */
export function provenanceClassColorClass(cls: ProvenanceClass): string {
  switch (cls) {
    case 'measured':  return 'bg-success';
    case 'entered':   return 'bg-fg-tone';
    case 'estimated': return 'bg-running';
    case 'derived':   return 'bg-running';
    case 'computed':  return 'bg-running';
    case 'system':    return 'bg-fg-faint';
  }
}

/** Inline style color value for use inside SVG or inline-style contexts. */
export function provenanceClassCssVar(cls: ProvenanceClass): string {
  switch (cls) {
    case 'measured':  return 'var(--success)';
    case 'entered':   return 'var(--fg-muted)';
    case 'estimated': return 'var(--running)';
    case 'derived':   return 'var(--running)';
    case 'computed':  return 'var(--running)';
    case 'system':    return 'var(--fg-faint)';
  }
}

/** Summarise provenance breakdown into "estimated fraction" (for chart shading). */
export function estimatedFraction(prov: ProvenanceBreakdown): number {
  const total =
    prov.measured + prov.entered + prov.estimated +
    prov.derived + prov.computed + prov.system;
  if (total === 0) return 0;
  return (prov.estimated + prov.derived + prov.computed + prov.system) / total;
}

/** Human label for the consumption dimension query param. */
export function dimensionLabel(dim: string): string {
  switch (dim) {
    case 'brand':   return 'By brand';
    case 'color':   return 'By colour';
    case 'printer': return 'By printer';
    case 'outcome': return 'By outcome';
    case 'total':   return 'Total';
    default:        return dim;
  }
}

/** Range preset options shown in ConsumptionRangePicker. */
export const RANGE_PRESETS = [
  { key: '30d',  label: '30d',  days: 30  },
  { key: '90d',  label: '90d',  days: 90  },
  { key: '365d', label: '365d', days: 365 },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]['key'];

/** Compute ISO since/until strings for a given preset. */
export function rangeWindow(preset: RangePreset): { since: string; until: string } {
  const until = new Date();
  const since = new Date(until);
  const days = RANGE_PRESETS.find((p) => p.key === preset)?.days ?? 30;
  since.setDate(since.getDate() - days);
  return { since: since.toISOString(), until: until.toISOString() };
}

/** Format grams as kg with 2dp. */
export function fmtKg(grams: number): string {
  return (grams / 1000).toFixed(2);
}

/** Format amount+unit into a display string. */
export function fmtAmount(amount: number, unit: string): string {
  if (unit === 'g') return `${fmtKg(amount)} kg`;
  if (unit === 'ml') return `${amount.toFixed(0)} ml`;
  return `${amount.toFixed(2)} ${unit}`;
}
