'use client';
import { usePathname } from 'next/navigation';

// TODO: auth integration pending V2-001-T4 — signOut callback will be added

const TITLES: Record<string, string> = {
  '/activity': 'Activity',
  '/queue': 'Queue',
  '/history': 'History',
  '/libraries': 'Libraries',
  '/sources': 'Sources',
  '/settings': 'Settings',
  '/system/tasks': 'System — Tasks',
  '/system/logs': 'System — Logs',
  '/system/health': 'System — Health',
};

export function Topbar() {
  const pathname = usePathname();
  const matched = Object.keys(TITLES)
    .sort((a, b) => b.length - a.length)
    .find((p) => pathname === p || pathname.startsWith(p + '/'));
  const title = matched ? TITLES[matched] : '';

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-900/60 px-6">
      <h1 className="text-base font-medium text-slate-200">{title}</h1>
      {/* TODO: auth integration pending V2-001-T4 — sign out button will be restored */}
      <div className="text-xs text-slate-400">Auth pending...</div>
    </header>
  );
}
