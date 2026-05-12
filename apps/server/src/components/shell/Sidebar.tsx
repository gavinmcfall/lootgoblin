'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, BarChart3, Beaker, BookOpen, Boxes, FolderTree, History, Radar, Settings, Timer, FileText, HeartPulse } from 'lucide-react';
import { GoblinMark } from '@/components/icons/GoblinMark';

// Routes + labels follow the design-system vocabulary (Activity / Stash / Hoard /
// History / Scouts / Settings). Old paths /queue /libraries /sources were renamed
// to /stash /hoard /scouts in this commit.
const NAV = [
  { href: '/activity', label: 'Activity', icon: Activity, meta: null as null | string | number },
  { href: '/stash', label: 'Stash', icon: Boxes, meta: null },
  { href: '/hoard', label: 'Hoard', icon: FolderTree, meta: null },
  { href: '/materials', label: 'Materials', icon: Beaker, meta: null },
  { href: '/grimoire', label: 'Grimoire', icon: BookOpen, meta: null },
  { href: '/reports', label: 'Reports', icon: BarChart3, meta: null },
  { href: '/history', label: 'History', icon: History, meta: null },
  { href: '/scouts', label: 'Scouts', icon: Radar, meta: null },
  { href: '/settings', label: 'Settings', icon: Settings, meta: null },
] as const;

const SYSTEM = [
  { href: '/system/tasks', label: 'Tasks', icon: Timer },
  { href: '/system/logs', label: 'Logs', icon: FileText },
  { href: '/system/health', label: 'Health', icon: HeartPulse },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const [expanded, setExpanded] = useState(true);
  // Hydrate from localStorage on mount to avoid SSR/CSR mismatch.
  useEffect(() => {
    try {
      const v = localStorage.getItem('lg-rail-expanded');
      if (v !== null) setExpanded(v === '1');
    } catch {}
  }, []);
  const toggle = () => {
    setExpanded((v) => {
      const nv = !v;
      try {
        localStorage.setItem('lg-rail-expanded', nv ? '1' : '0');
      } catch {}
      return nv;
    });
  };

  const w = expanded ? 'w-[210px]' : 'w-[68px]';

  return (
    <aside
      className={`${w} shrink-0 border-r border-hairline bg-surface flex flex-col px-[10px] py-[14px] gap-1 transition-[width] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] overflow-hidden relative z-[2]`}
    >
      {/* Brand */}
      <div className="flex items-center gap-[10px] px-1 pb-[10px] min-h-[40px]">
        <div
          className="w-10 h-10 shrink-0 rounded-lg bg-accent text-accent-ink flex items-center justify-center"
          style={{ boxShadow: '0 2px 0 var(--accent-deep)' }}
        >
          <GoblinMark size={22} />
        </div>
        <div
          className={`flex flex-col leading-[1.1] flex-1 transition-opacity duration-[160ms] whitespace-nowrap ${
            expanded ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <span className="font-serif text-[19px] text-fg tracking-[-0.3px]">lootgoblin</span>
          <span className="font-mono text-[9px] text-fg-faint uppercase tracking-[0.8px]">v2.0 · paired</span>
        </div>
      </div>

      <div className="h-px bg-hairline mx-[2px] mt-[2px] mb-[10px]" />

      {/* Primary nav */}
      {NAV.map(({ href, label, icon: Icon, meta }) => {
        const on = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-3 px-[10px] py-2 rounded-lg relative text-[13px] ${
              on
                ? 'bg-accent-soft text-accent font-medium'
                : 'bg-transparent text-fg-muted hover:text-fg'
            }`}
          >
            <span className="w-[22px] flex items-center justify-center shrink-0">
              <Icon className="h-[16px] w-[16px]" strokeWidth={1.6} />
            </span>
            <span
              className={`flex-1 whitespace-nowrap transition-opacity duration-[160ms] ${
                expanded ? 'opacity-100' : 'opacity-0'
              }`}
            >
              {label}
            </span>
            {meta != null && expanded && (
              <span className={`font-mono text-[10px] px-[7px] py-px rounded-[10px] border ${
                on ? 'bg-transparent text-accent border-accent-edge' : 'bg-surface-2 text-fg-muted border-hairline'
              }`}>
                {meta}
              </span>
            )}
            {on && (
              <span
                className={`absolute top-2 bottom-2 w-[2px] bg-accent rounded-sm ${
                  expanded ? '-left-[10px]' : 'left-0'
                }`}
              />
            )}
          </Link>
        );
      })}

      {/* System sub-nav */}
      <div className="mt-3 pt-3 border-t border-hairline flex flex-col gap-1">
        {expanded && (
          <div className="px-[10px] pb-1 font-mono text-[9px] uppercase tracking-[1px] text-fg-faint">
            System
          </div>
        )}
        {SYSTEM.map(({ href, label, icon: Icon }) => {
          const on = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-[10px] py-[5px] rounded-lg relative text-[12px] ${
                on
                  ? 'bg-accent-soft text-accent font-medium'
                  : 'bg-transparent text-fg-faint hover:text-fg-muted'
              }`}
            >
              <span className="w-[22px] flex items-center justify-center shrink-0">
                <Icon className="h-[14px] w-[14px]" strokeWidth={1.6} />
              </span>
              <span
                className={`flex-1 whitespace-nowrap transition-opacity duration-[160ms] ${
                  expanded ? 'opacity-100' : 'opacity-0'
                }`}
              >
                {label}
              </span>
              {on && (
                <span
                  className={`absolute top-1 bottom-1 w-[2px] bg-accent rounded-sm ${
                    expanded ? '-left-[10px]' : 'left-0'
                  }`}
                />
              )}
            </Link>
          );
        })}
      </div>

      {/* Today's loot quota */}
      <div className="mt-auto pt-3 px-2 pb-1 border-t border-hairline min-h-[82px]">
        <div
          className={`font-mono text-[9px] text-fg-faint tracking-[1px] uppercase mb-1.5 whitespace-nowrap transition-opacity duration-[160ms] h-[11px] ${
            expanded ? 'opacity-100' : 'opacity-0'
          }`}
        >
          Today&apos;s loot
        </div>
        <div className={`flex items-baseline gap-1.5 ${expanded ? 'justify-start' : 'justify-center'}`}>
          <span className="font-serif text-[26px] text-fg tracking-[-0.8px] leading-none">47</span>
          {expanded && <span className="font-mono text-[10px] text-fg-muted whitespace-nowrap">· 2.3 GB</span>}
        </div>
        <div
          className={`mt-2 h-[3px] rounded-sm bg-surface-2 overflow-hidden transition-[width] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] ${
            expanded ? 'w-full' : 'w-6 mx-auto'
          }`}
        >
          <div className="h-full bg-accent" style={{ width: '68%' }} />
        </div>
      </div>

      {/* Collapse toggle */}
      <button
        type="button"
        onClick={toggle}
        aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        className={`mt-2 px-2 py-[7px] flex items-center gap-2 rounded-lg bg-transparent border border-hairline text-fg-faint cursor-pointer font-mono text-[10px] tracking-[1px] uppercase ${
          expanded ? 'justify-end' : 'justify-center'
        }`}
      >
        {expanded && <span>collapse</span>}
        <span className="text-[14px] leading-none">{expanded ? '‹' : '›'}</span>
      </button>
    </aside>
  );
}
