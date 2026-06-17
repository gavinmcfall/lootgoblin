// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Masthead inside the wizard main pane.
// Ported from StepMasthead in planning/design-system/lib/page-adoption.jsx.

import type { ReactNode } from 'react';

export function StepMasthead({
  kw,
  title,
  sub,
  right,
}: {
  kw: string;
  title: string;
  sub: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="mb-1.5 flex items-baseline gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">{kw}</span>
        <span className="flex-1 border-b border-hairline" />
        {right}
      </div>
      <h1 className="m-0 font-serif text-[40px] font-normal leading-[1.02] tracking-[-1.1px] text-fg">
        {title}
      </h1>
      <p className="mt-1.5 font-serif text-[16px] italic text-fg-muted">{sub}</p>
    </div>
  );
}
