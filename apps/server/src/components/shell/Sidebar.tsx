'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, ListOrdered, History, FolderTree, Plug, Settings, Timer, FileText, HeartPulse } from 'lucide-react';

const NAV = [
  { href: '/activity', label: 'Activity', icon: Activity },
  { href: '/queue', label: 'Queue', icon: ListOrdered },
  { href: '/history', label: 'History', icon: History },
  { href: '/libraries', label: 'Libraries', icon: FolderTree },
  { href: '/sources', label: 'Sources', icon: Plug },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

const SYSTEM = [
  { href: '/system/tasks', label: 'Tasks', icon: Timer },
  { href: '/system/logs', label: 'Logs', icon: FileText },
  { href: '/system/health', label: 'Health', icon: HeartPulse },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <aside className="w-56 shrink-0 border-r border-slate-800 bg-slate-900">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-emerald-500 to-sky-500 text-sm">🎯</div>
        <span className="text-sm font-semibold">lootgoblin</span>
      </div>
      <nav className="flex flex-col gap-0.5 border-t border-slate-800 py-2">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-3 px-4 py-2 text-sm border-l-2 ${
              isActive(href)
                ? 'border-sky-500 bg-sky-500/10 text-sky-100'
                : 'border-transparent text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="border-t border-slate-800 py-2">
        <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">System</div>
        {SYSTEM.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-3 px-4 py-1.5 text-xs border-l-2 ${
              isActive(href)
                ? 'border-sky-500 bg-sky-500/10 text-sky-100'
                : 'border-transparent text-slate-500 hover:bg-slate-800/50 hover:text-slate-300'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Link>
        ))}
      </div>
    </aside>
  );
}
