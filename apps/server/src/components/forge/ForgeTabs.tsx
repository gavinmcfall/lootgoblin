// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/forge/printers', label: 'Printers' },
  { href: '/forge/dispatch', label: 'Dispatch' },
  { href: '/forge/inboxes', label: 'Inboxes' },
] as const;

/** Sub-nav tab strip rendered at the top of each /forge/* page. */
export function ForgeTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-hairline -mt-2 mb-5">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${
              active
                ? 'border-accent text-accent'
                : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
