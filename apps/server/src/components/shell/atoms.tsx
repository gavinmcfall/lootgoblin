// apps/server/src/components/shell/atoms.tsx
// Shared presentational primitives. Ported from
// planning/design-system/lib/app-shell.jsx (SectionTitle, KV, MetaBadge).

import type { ReactNode } from 'react';

export function SectionTitle({
  children,
  meta,
  right,
}: {
  children: ReactNode;
  meta?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3.5 flex items-baseline gap-3">
      <span className="font-serif text-[19px] tracking-[-0.3px] text-fg">{children}</span>
      {meta && (
        <span className="font-mono text-[10.5px] tracking-[0.4px] text-fg-faint">{meta}</span>
      )}
      <div className="flex-1 border-b border-dashed border-hairline" />
      {right}
    </div>
  );
}

export function KV({
  k,
  v,
  mono,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2.5 border-b border-dashed border-hairline py-1.5">
      <span className="min-w-[110px] font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">
        {k}
      </span>
      <span className={`text-[12.5px] text-fg ${mono ? 'font-mono' : ''}`}>{v}</span>
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'running' | 'success' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg-muted border-hairline',
  accent: 'bg-accent-soft text-accent border-accent-edge',
  running: 'bg-running-bg text-running border-running',
  success: 'bg-success-bg text-success border-success',
  danger: 'bg-danger-bg text-danger border-danger',
};

export function MetaBadge({
  tone = 'neutral',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.6px] ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

/** Small framed container. Pages compose Tiles inside grids. */
export function Tile({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-md border border-hairline bg-surface ${className}`}>{children}</div>
  );
}

/** Centred placeholder used by empty states. */
export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[140px] items-center justify-center rounded-md border border-dashed border-hairline bg-surface-2 px-6 py-8 text-center font-serif text-[14.5px] italic text-fg-faint">
      {children}
    </div>
  );
}
