'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/settings/auth', label: 'Auth' },
  { href: '/settings/api-keys', label: 'API Keys' },
  { href: '/settings/extensions', label: 'Extensions' },
  { href: '/settings/backup', label: 'Backup' },
] as const;

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-slate-800 -mt-2">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${
              active
                ? 'border-sky-500 text-sky-100'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
