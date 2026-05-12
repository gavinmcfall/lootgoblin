'use client';
import { usePathname, useRouter } from 'next/navigation';
import { createAuthClient } from 'better-auth/client';
import { Search } from 'lucide-react';
import { useSearchPalette } from '@/components/shell/SearchPaletteProvider';

const authClient = createAuthClient();

const TITLES: Record<string, { title: string; sub: string }> = {
  '/activity': { title: 'Activity', sub: '2 running · 12 stashed · 47 looted today' },
  '/stash': { title: 'Stash', sub: '12 items ready · next push in 4m' },
  '/hoard': { title: 'Hoard', sub: 'libraries · destinations · path templates' },
  '/history': { title: 'History', sub: 'everything that ever happened in the container' },
  '/scouts': { title: 'Scouts', sub: 'sources · credentials · scrape sessions' },
  '/settings': { title: 'Settings', sub: 'connections · container · quotas' },
  '/system/tasks': { title: 'System — Tasks', sub: 'background workers + queue depths' },
  '/system/logs': { title: 'System — Logs', sub: 'recent log lines from this container' },
  '/system/health': { title: 'System — Health', sub: 'live health probes + metrics' },
};

export function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { open: openPalette } = useSearchPalette();
  const matched = Object.keys(TITLES)
    .sort((a, b) => b.length - a.length)
    .find((p) => pathname === p || pathname.startsWith(p + '/'));
  const meta = matched ? TITLES[matched]! : { title: '', sub: '' };

  async function handleSignOut() {
    await authClient.signOut();
    router.push('/login');
  }

  return (
    <header className="shrink-0 flex items-center gap-[14px] px-5 py-3 border-b border-hairline bg-surface">
      <div className="flex flex-col leading-[1.15] min-w-0">
        <span className="font-serif text-[22px] text-fg tracking-[-0.4px] truncate">{meta.title}</span>
        <span className="font-mono text-[11px] text-fg-faint tracking-[0.3px] truncate">{meta.sub}</span>
      </div>

      <button
        type="button"
        onClick={openPalette}
        aria-label="Open search palette (⌘K)"
        className="flex-1 ml-4 max-w-[480px] flex items-center gap-2 bg-surface-2 border border-hairline rounded-md px-[10px] py-1.5 text-[12.5px] text-fg-muted hover:border-accent/40 transition-colors cursor-text text-left"
      >
        <Search className="h-[14px] w-[14px] text-fg-faint" strokeWidth={1.7} />
        <span className="text-fg-faint">Search stash, hoard, history…</span>
        <span className="ml-auto font-mono text-[10px] px-[5px] py-px rounded-sm bg-surface text-fg-faint border border-hairline">
          ⌘K
        </span>
      </button>

      <button
        type="button"
        onClick={handleSignOut}
        className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint hover:text-fg transition-colors"
      >
        Sign out
      </button>
    </header>
  );
}
