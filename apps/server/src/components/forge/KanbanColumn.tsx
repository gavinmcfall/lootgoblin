// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// KanbanColumn — one column per status bucket (Queued / Running / Done).
// Renders a header bar + list of child cards passed via `children`.

import type { ReactNode } from 'react';
import { EmptyHint } from '@/components/shell/atoms';

interface KanbanColumnProps {
  title: string;
  count: number;
  eyebrow?: string;
  children: ReactNode;
  /** Optional footer slot (e.g. "earlier today" section). */
  footer?: ReactNode;
}

export function KanbanColumn({ title, count, eyebrow, children, footer }: KanbanColumnProps) {
  const isEmpty = count === 0;
  return (
    <section className="flex flex-col min-h-[400px] rounded-lg border border-hairline bg-surface">
      {/* Column header */}
      <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-hairline">
        <span className="font-mono text-[10px] uppercase tracking-[1.4px] text-fg-faint flex-1">
          {title}
        </span>
        {eyebrow && (
          <span className="font-serif italic text-[12px] text-fg-muted">{eyebrow}</span>
        )}
        <span className="font-mono text-[10.5px] text-fg-muted">{count}</span>
      </div>

      {/* Card list */}
      <div className="flex-1 p-2.5 flex flex-col gap-2.5">
        {isEmpty ? (
          <EmptyHint>nothing here</EmptyHint>
        ) : (
          children
        )}
      </div>

      {/* Optional footer */}
      {footer && (
        <div className="border-t border-hairline p-2.5">
          {footer}
        </div>
      )}
    </section>
  );
}
