// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// SearchResultRow — single result row: icon + kind chip + title + sub + meta + selected highlight.
// Canvas reference: CKResultRow (page-search-palette.jsx line 29–62).

import type { ReactNode } from 'react';
import { MetaBadge } from '@/components/shell/atoms';
import type { Tone } from '@/components/shell/atoms';
import { KbdHint } from './KbdHint';

interface SearchResultRowProps {
  id?: string;
  icon: ReactNode;
  kind: string;
  kindTone?: Tone;
  title: string;
  sub?: string;
  meta?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  onClick?: () => void;
  role?: string;
  'aria-selected'?: boolean;
}

export function SearchResultRow({
  id,
  icon,
  kind,
  kindTone = 'neutral',
  title,
  sub,
  meta,
  selected = false,
  danger = false,
  onClick,
  role,
  'aria-selected': ariaSelected,
}: SearchResultRowProps) {
  return (
    <div
      id={id}
      role={role}
      aria-selected={ariaSelected}
      onClick={onClick}
      className={[
        'grid cursor-pointer items-center gap-3 px-3.5 py-2.5',
        'border-l-2',
        selected
          ? 'border-accent bg-accent-soft'
          : 'border-transparent hover:bg-surface-hi',
      ].join(' ')}
      style={{ gridTemplateColumns: '36px 1fr auto' }}
    >
      {/* Icon box */}
      <div
        className={[
          'flex h-7 w-7 items-center justify-center overflow-hidden rounded',
          'font-mono text-[12px] font-bold',
          selected
            ? 'bg-accent text-accent-ink'
            : 'border border-hairline bg-surface-2 text-fg-muted',
        ].join(' ')}
      >
        {icon}
      </div>

      {/* Text */}
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 overflow-hidden">
          <MetaBadge tone={danger ? 'danger' : kindTone}>{kind}</MetaBadge>
          <span className="truncate font-sans text-[13px] font-medium text-fg">
            {title}
          </span>
        </div>
        {sub && (
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-fg-muted">
            {sub}
          </div>
        )}
      </div>

      {/* Meta + Enter hint */}
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-fg-faint">
        {meta}
        {selected && <KbdHint accent>⏎</KbdHint>}
      </div>
    </div>
  );
}
