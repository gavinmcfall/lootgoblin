// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Right "reading rail" of explanatory RailBlocks for the Adoption wizard.
// Ported from AdoptionReadingRail + RailBlock in
// planning/design-system/lib/page-adoption.jsx. Copy is rewritten to describe
// the REAL backend behaviour (synchronous scan/preview/apply, no live counters,
// candidate-level selection, copy-then-cleanup vs in-place).

import type { ReactNode } from 'react';

export function AdoptionReadingRail({ children }: { children: ReactNode }) {
  return (
    <aside className="flex w-[260px] shrink-0 flex-col gap-5 border-l border-hairline pl-5">
      {children}
    </aside>
  );
}

export function RailBlock({
  kw,
  title,
  children,
}: {
  kw: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[1.5px] text-accent">{kw}</div>
      <div className="mt-1 font-serif text-[17px] leading-tight tracking-[-0.3px] text-fg">
        {title}
      </div>
      <div className="mt-2 font-serif text-[12.5px] italic leading-relaxed text-fg-muted">
        {children}
      </div>
    </div>
  );
}
