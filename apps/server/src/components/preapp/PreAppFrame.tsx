// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared pre-app visual frame — used by /login and /setup.
// Ported from planning/design-system/exports/jsx/page-login.jsx (PreAppFrame).
// Inline-style mock translated to Tailwind token classes. Standalone pages
// (no app shell): full-bg frame, top-left masthead, centered card column,
// faint footer.

import type { ReactNode } from 'react';
import { GoblinMark } from '@/components/icons/GoblinMark';

/**
 * Version line shown in the masthead. Mirrors the Sidebar wordmark treatment
 * (components/shell/Sidebar.tsx shows "v2.0 · paired"); we reuse the real
 * "v2.0" string rather than the design mock's invented "v0.4".
 */
const VERSION_LINE = 'self-hosted · v2.0';

export function PreAppFrame({
  children,
  footer = true,
}: {
  children: ReactNode;
  footer?: boolean;
}) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-bg font-sans text-fg">
      {/* Faint masthead wordmark — top left, anchors brand without crowding. */}
      <div className="flex items-center gap-2.5 px-8 py-6">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-accent-ink shadow-sm"
          style={{ boxShadow: '0 2px 0 var(--accent-deep)' }}
        >
          <GoblinMark size={22} />
        </div>
        <div className="leading-none">
          <div className="font-serif text-[16px] font-semibold tracking-[-0.2px] text-fg">
            LootGoblin
          </div>
          <div className="mt-[3px] font-mono text-[9px] uppercase tracking-[1.6px] text-fg-faint">
            {VERSION_LINE}
          </div>
        </div>
      </div>

      {/* Card column. */}
      <div className="flex flex-1 items-center justify-center px-8 pb-8">{children}</div>

      {/* Faint footer — tone, not navigation. */}
      {footer && (
        <div className="px-8 py-5 text-center font-mono text-[10.5px] tracking-[0.8px] text-fg-ghost">
          the goblin watches the gate, not the road
        </div>
      )}
    </div>
  );
}
