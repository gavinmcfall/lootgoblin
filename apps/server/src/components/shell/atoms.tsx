// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// apps/server/src/components/shell/atoms.tsx
// Shared presentational primitives. Ported from
// planning/design-system/lib/app-shell.jsx (SectionTitle, KV, MetaBadge).

import type { ReactNode } from 'react';

export function SectionTitle({
  children,
  meta,
  right,
  as: Tag = 'h2',
}: {
  children: ReactNode;
  meta?: string;
  right?: ReactNode;
  as?: 'h2' | 'h3' | 'h4';
}) {
  return (
    <div className="mb-3.5 flex items-baseline gap-3">
      <Tag className="m-0 font-serif text-[19px] font-normal tracking-[-0.3px] text-fg">
        {children}
      </Tag>
      {meta && (
        <span className="font-mono text-[10.5px] tracking-[0.4px] text-fg-faint">{meta}</span>
      )}
      <div className="flex-1 border-b border-dashed border-hairline" />
      {right}
    </div>
  );
}

/**
 * Key/value row rendered as a `<dt>`/`<dd>` pair for semantic association.
 * Wrap a group of `<KV>` rows in `<dl>` at the call site for semantic
 * correctness. (HTML5 permits `<div>` wrappers around `<dt>`/`<dd>` groups
 * inside `<dl>` — see https://html.spec.whatwg.org/multipage/grouping-content.html#the-dl-element.)
 */
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
      <dt className="min-w-[110px] font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">
        {k}
      </dt>
      <dd className={`m-0 text-[12.5px] text-fg ${mono ? 'font-mono' : ''}`}>{v}</dd>
    </div>
  );
}

export type Tone = 'neutral' | 'accent' | 'running' | 'success' | 'danger';

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

/**
 * Small framed container. Pages compose Tiles inside grids.
 *
 * Note: `className` is APPENDED to defaults, not merged. Pass layout/spacing
 * classes only (`p-4`, `col-span-2`, `h-full`). Do NOT override `bg-surface`,
 * `border-hairline`, or `rounded-md` via className — without `tailwind-merge`
 * the cascade order is non-deterministic.
 */
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
    <div
      role="status"
      className="flex min-h-[140px] items-center justify-center rounded-md border border-dashed border-hairline bg-surface-2 px-6 py-8 text-center font-serif text-[14.5px] italic text-fg-faint"
    >
      {children}
    </div>
  );
}
