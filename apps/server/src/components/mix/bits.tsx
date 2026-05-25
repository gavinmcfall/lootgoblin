'use client';
// Small shared presentational bits for the Guided Mix flow.
// Ported from planning/design-system/exports/jsx/page-mix-manual.jsx
// (ProvenanceTag, ToleranceBand, DeviationPill). Inline `t.*` token styles
// from the mock are rewritten as Tailwind token classes per house convention.

/**
 * ProvenanceTag — Space Mono, faint, uppercase. Steady-state user-supplied
 * truth, deliberately NOT dressed as success/warning. For manual entry every
 * row is `entered`.
 */
export function ProvenanceTag({
  kind = 'entered',
  size = 'sm',
}: {
  kind?: 'entered' | 'measured' | 'estimated';
  size?: 'sm' | 'md';
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono font-medium uppercase tracking-[1.4px] text-fg-faint ${
        size === 'sm' ? 'text-[9px]' : 'text-[10px]'
      }`}
    >
      <span className="h-1 w-1 rounded-full bg-fg-ghost" />
      {kind}
    </span>
  );
}

/**
 * ToleranceBand — horizontal bar showing target ± tol with a current-weight
 * pip. Visible range is target ± 2.5·tol so the band has shoulders. Pip color:
 * success (in range), danger (over), running (under), faint (no reading).
 *
 * Only rendered when the component has a defined tolerance.
 */
export function ToleranceBand({
  current,
  target,
  tol,
  widthPx = 150,
}: {
  current: number | null;
  target: number;
  tol: number;
  widthPx?: number;
}) {
  const range = tol * 5;
  const min = target - range / 2;
  const pos = (v: number) => Math.max(0, Math.min(1, (v - min) / range)) * 100;
  const greenL = pos(target - tol);
  const greenR = pos(target + tol);
  const targetX = pos(target);
  const currentX = current != null ? pos(current) : null;

  const isOver = current != null && current > target + tol;
  const isUnder = current != null && current < target - tol;
  const inRange = current != null && !isOver && !isUnder;

  const pipClass = inRange
    ? 'bg-success'
    : isOver
      ? 'bg-danger'
      : isUnder
        ? 'bg-running'
        : 'bg-fg-faint';

  return (
    <div
      className="relative flex h-[22px] items-center"
      style={{ width: widthPx }}
    >
      {/* full track */}
      <div className="absolute left-0 right-0 h-1.5 rounded-[3px] border border-hairline bg-surface-2" />
      {/* tolerance window */}
      <div
        className="absolute h-1.5 rounded-[3px] border border-success/40 bg-success-bg"
        style={{ left: `${greenL}%`, width: `${greenR - greenL}%` }}
      />
      {/* target tick */}
      <div
        className="absolute h-3.5 w-px -translate-x-1/2 bg-fg-muted"
        style={{ left: `${targetX}%` }}
      />
      {/* current pip */}
      {currentX != null && (
        <div
          className={`absolute h-3 w-3 -translate-x-1/2 rounded-full border-2 border-surface shadow-sm ${pipClass}`}
          style={{ left: `${currentX}%` }}
        />
      )}
    </div>
  );
}

function formatDeviation(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(Math.abs(n) < 10 ? 1 : 0) + ' g';
}

/**
 * DeviationPill — verdict pill derived from current vs target ± tol.
 * Rendered only when the component has a tolerance. When no reading yet,
 * shows an em-dash.
 */
export function DeviationPill({
  current,
  target,
  tol,
}: {
  current: number | null;
  target: number;
  tol: number;
}) {
  if (current == null) {
    return (
      <span className="font-mono text-[10px] tracking-[0.6px] text-fg-ghost">—</span>
    );
  }
  const dev = current - target;
  const isOver = dev > tol;
  const isUnder = dev < -tol;
  const inRange = !isOver && !isUnder;

  const tone = inRange
    ? { cls: 'bg-success-bg text-success border-success/40', label: 'in tolerance' }
    : isOver
      ? { cls: 'bg-danger-bg text-danger border-danger/40', label: 'over' }
      : { cls: 'bg-running-bg text-running border-running/40', label: 'under' };

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.4px] ${tone.cls}`}
    >
      <span>{tone.label}</span>
      <span className="font-medium opacity-70">{formatDeviation(dev)}</span>
    </span>
  );
}

/**
 * DeviationOnly — when a component has NO tolerance, we show the raw deviation
 * (entered minus target, in grams) with no verdict tone. Quiet, faint.
 */
export function DeviationOnly({
  current,
  target,
}: {
  current: number | null;
  target: number;
}) {
  if (current == null) {
    return (
      <span className="font-mono text-[10px] tracking-[0.6px] text-fg-ghost">—</span>
    );
  }
  return (
    <span className="font-mono text-[10.5px] text-fg-faint">
      {formatDeviation(current - target)}
    </span>
  );
}
