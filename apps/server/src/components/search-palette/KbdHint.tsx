// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// KbdHint — keyboard key chip shown in the palette footer.
// Canvas reference: CKKbd (page-search-palette.jsx line 15–27).

import type { ReactNode } from 'react';

interface KbdHintProps {
  accent?: boolean;
  children: ReactNode;
}

export function KbdHint({ accent = false, children }: KbdHintProps) {
  return (
    <span
      className={[
        'inline-flex min-w-[18px] items-center justify-center rounded-sm border px-1.5 py-px',
        'font-mono text-[9.5px] font-semibold tracking-[0.4px]',
        accent
          ? 'border-accent-edge bg-accent-soft text-accent'
          : 'border-hairline bg-surface-2 text-fg-muted',
      ].join(' ')}
    >
      {children}
    </span>
  );
}
