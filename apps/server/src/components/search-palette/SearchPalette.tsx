'use client';
// SearchPalette — global ⌘K overlay.
// Ports three variants from page-search-palette.jsx:
//   - Empty (no query): recents + suggested commands
//   - Active (query): Loot results (FTS5 wired) + stubbed other kinds
//   - Commands (> prefix): static client-side command list
//
// Full dialog a11y: role=dialog + aria-modal + aria-labelledby +
// aria-activedescendant + role=listbox + role=option + focus trap + focus restore.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { SearchPaletteInput } from './SearchPaletteInput';
import { SearchPaletteFooter } from './SearchPaletteFooter';
import { SearchResultRow } from './SearchResultRow';
import { SearchGroupHeader } from './SearchGroupHeader';

// ── Types ──────────────────────────────────────────────────────────────────────

interface LootResult {
  id: string;
  title: string;
  description?: string | null;
  creator?: string | null;
  tags?: string[];
  collectionId?: string | null;
}

interface SearchResponse {
  items: LootResult[];
  total: number;
  limit: number;
  offset: number;
}

interface Command {
  id: string;
  icon: string;
  title: string;
  sub: string;
  action: () => void;
}

// ── Focusable selector (matches RetireDialog pattern) ─────────────────────────
const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// ── Static commands list ──────────────────────────────────────────────────────
function useCommands(
  router: ReturnType<typeof useRouter>,
  close: () => void,
  filter: string,
): Command[] {
  const all: Command[] = [
    {
      id: 'new-library',
      icon: '+',
      title: 'New library…',
      sub: 'Define schema and choose a Stash root',
      action: () => { router.push('/hoard/new'); close(); },
    },
    {
      id: 'new-credential',
      icon: '⚷',
      title: 'New credential…',
      sub: 'Add a source credential to Scouts',
      action: () => { router.push('/scouts'); close(); },
    },
    {
      id: 'new-watch',
      icon: '⊙',
      title: 'New watchlist rule…',
      sub: 'Watch for new items from a source',
      action: () => { router.push('/scouts/watchlist/new'); close(); },
    },
    {
      id: 'new-material',
      icon: '◆',
      title: 'New material…',
      sub: 'Register a spool, bottle, or custom',
      action: () => { router.push('/materials/new'); close(); },
    },
    {
      id: 'create-profile',
      icon: '⊞',
      title: 'Create slicer profile…',
      sub: 'Add a Grimoire slicer profile',
      action: () => { router.push('/grimoire/slicer-profiles/new'); close(); },
    },
    {
      id: 'theme-dark',
      icon: '◐',
      title: 'Theme: dark',
      sub: 'Switch to dark mode',
      action: () => {
        document.documentElement.setAttribute('data-theme', 'dark');
        close();
      },
    },
    {
      id: 'theme-light',
      icon: '◑',
      title: 'Theme: light',
      sub: 'Switch to light mode',
      action: () => {
        document.documentElement.setAttribute('data-theme', 'light');
        close();
      },
    },
    {
      id: 'accent-gold',
      icon: '●',
      title: 'Accent: gold',
      sub: 'Switch accent colour to warm gold',
      action: () => {
        document.documentElement.setAttribute('data-accent', 'gold');
        close();
      },
    },
    {
      id: 'accent-emerald',
      icon: '●',
      title: 'Accent: emerald',
      sub: 'Switch accent colour to emerald',
      action: () => {
        document.documentElement.setAttribute('data-accent', 'emerald');
        close();
      },
    },
    {
      id: 'accent-violet',
      icon: '●',
      title: 'Accent: violet',
      sub: 'Switch accent colour to violet',
      action: () => {
        document.documentElement.setAttribute('data-accent', 'violet');
        close();
      },
    },
    {
      id: 'accent-copper',
      icon: '●',
      title: 'Accent: copper',
      sub: 'Switch accent colour to copper',
      action: () => {
        document.documentElement.setAttribute('data-accent', 'copper');
        close();
      },
    },
  ];

  const q = filter.trim().toLowerCase();
  if (!q) return all;
  return all.filter(
    (c) =>
      c.title.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q),
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface SearchPaletteProps {
  onClose: () => void;
}

export function SearchPalette({ onClose }: SearchPaletteProps) {
  const dialogId = useId();
  const labelId = useId();
  const inputId = useId();

  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  const [rawQuery, setRawQuery] = useState('');
  const commandsMode = rawQuery.startsWith('>');
  const searchQuery = commandsMode ? rawQuery.slice(1).trimStart() : rawQuery;

  // Separate index tracks for loot vs commands so switching modes resets it
  const [selectedIndex, setSelectedIndex] = useState(0);

  // ── FTS5 search (Loot only, wired to /api/v1/search) ──────────────────────
  const { data, isError } = useQuery<SearchResponse>({
    queryKey: ['search', { q: searchQuery }],
    queryFn: async ({ queryKey }) => {
      const { q } = (queryKey as [string, { q: string }])[1];
      const res = await fetch(
        `/api/v1/search?q=${encodeURIComponent(q)}&limit=10`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<SearchResponse>;
    },
    enabled: !commandsMode && searchQuery.trim().length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev, // keep showing previous results while next fetch loads
  });

  const lootResults = data?.items ?? [];

  // ── Commands (client-side, filtered) ──────────────────────────────────────
  const commands = useCommands(router, onClose, searchQuery);

  // ── Focus management ──────────────────────────────────────────────────────
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      const prev = previousFocusRef.current;
      if (prev instanceof HTMLElement || prev instanceof SVGElement) {
        prev.focus();
      }
    };
  }, []);

  // ── Focus trap + Escape ───────────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && containerRef.current) {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(
          FOCUSABLE_SELECTOR,
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // ── Arrow / Enter navigation ──────────────────────────────────────────────
  const totalResults = commandsMode ? commands.length : lootResults.length;

  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % Math.max(totalResults, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) =>
          i === 0 ? Math.max(totalResults - 1, 0) : i - 1,
        );
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (commandsMode) {
          commands[selectedIndex]?.action();
        } else if (lootResults[selectedIndex]) {
          router.push(`/loot/${lootResults[selectedIndex]!.id}`);
          onClose();
        }
      }
    },
    [totalResults, commandsMode, commands, lootResults, selectedIndex, router, onClose],
  );

  // Reset selection when query or mode changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [rawQuery]);

  // ── aria-activedescendant ─────────────────────────────────────────────────
  const activeId = commandsMode
    ? totalResults > 0
      ? `${dialogId}-cmd-${selectedIndex}`
      : undefined
    : lootResults.length > 0
    ? `${dialogId}-loot-${selectedIndex}`
    : undefined;

  // ── Empty (no query) state ─────────────────────────────────────────────────
  const isEmpty = !rawQuery.trim();

  // ── Render ─────────────────────────────────────────────────────────────────
  const palette = (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 px-4 pt-20"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-hidden="false"
    >
      {/* Dialog frame — plain div (NOT Tile so we control bg/border/shadow exactly) */}
      <div
        ref={containerRef}
        id={dialogId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        className="flex w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg"
        style={{ maxHeight: '80vh' }}
      >
        <SearchPaletteInput
          inputRef={inputRef}
          inputId={inputId}
          labelId={labelId}
          value={rawQuery}
          onChange={setRawQuery}
          onKeyDown={handleInputKeyDown}
          commandsMode={commandsMode}
          activeDescendant={activeId}
        />

        {/* Results area */}
        <div className="flex-1 overflow-y-auto" role="listbox">
          {/* ── Commands mode ── */}
          {commandsMode && (
            <>
              <SearchGroupHeader label="Commands" count={commands.length} />
              {commands.length === 0 ? (
                <p className="px-4 py-3 font-mono text-[10.5px] text-fg-faint">
                  No matching commands.
                </p>
              ) : (
                commands.map((cmd, i) => (
                  <SearchResultRow
                    key={cmd.id}
                    id={`${dialogId}-cmd-${i}`}
                    role="option"
                    aria-selected={i === selectedIndex}
                    icon={cmd.icon}
                    kind="Cmd"
                    kindTone="accent"
                    title={cmd.title}
                    sub={cmd.sub}
                    selected={i === selectedIndex}
                    onClick={cmd.action}
                  />
                ))
              )}
            </>
          )}

          {/* ── Search mode ── */}
          {!commandsMode && isEmpty && (
            <div className="px-4 py-3">
              <SearchGroupHeader label="Suggested commands" />
              {[
                { id: 'sg-new-lib', icon: '+', title: 'New library…', sub: 'Define schema and choose a Stash root', href: '/hoard/new' },
                { id: 'sg-new-mat', icon: '◆', title: 'New material…', sub: 'Register a spool, bottle, or custom', href: '/materials/new' },
                { id: 'sg-new-watch', icon: '⊙', title: 'New watchlist rule…', sub: 'Watch for new items from a source', href: '/scouts/watchlist/new' },
              ].map((s, i) => (
                <SearchResultRow
                  key={s.id}
                  id={`${dialogId}-sug-${i}`}
                  role="option"
                  aria-selected={false}
                  icon={s.icon}
                  kind="Cmd"
                  kindTone="accent"
                  title={s.title}
                  sub={s.sub}
                  onClick={() => { router.push(s.href); onClose(); }}
                />
              ))}
              <p className="mt-3 px-1 font-mono text-[10.5px] italic text-fg-faint">
                Type to search your hoard, or &gt; to run a command.
              </p>
            </div>
          )}

          {!commandsMode && !isEmpty && (
            <>
              {/* Loot (live FTS5) */}
              <SearchGroupHeader
                label="Loot"
                count={isError ? undefined : data?.total}
              />
              {isError ? (
                <p className="px-4 py-2 font-mono text-[10.5px] text-fg-muted">
                  Search failed.
                </p>
              ) : lootResults.length === 0 && searchQuery.trim() ? (
                <p className="px-4 py-2 font-mono text-[10.5px] text-fg-faint">
                  No loot found.
                </p>
              ) : (
                lootResults.map((item, i) => (
                  <SearchResultRow
                    key={item.id}
                    id={`${dialogId}-loot-${i}`}
                    role="option"
                    aria-selected={i === selectedIndex}
                    icon="◫"
                    kind="Loot"
                    title={item.title}
                    sub={item.creator ?? undefined}
                    selected={i === selectedIndex}
                    onClick={() => { router.push(`/loot/${item.id}`); onClose(); }}
                  />
                ))
              )}

              {/* Stubbed future result kinds — other indexes not yet landed */}
              {/* TODO: replace stubs when cross-kind search backend ships */}
              <SearchGroupHeader label="Libraries" />
              <p className="px-4 py-2 font-mono text-[10.5px] text-fg-faint">
                Other result kinds coming when their indexes land.
              </p>

              <SearchGroupHeader label="Scouts" />
              <p className="px-4 py-2 font-mono text-[10.5px] text-fg-faint">
                Other result kinds coming when their indexes land.
              </p>

              <SearchGroupHeader label="Materials" />
              <p className="px-4 py-2 font-mono text-[10.5px] text-fg-faint">
                Other result kinds coming when their indexes land.
              </p>
            </>
          )}
        </div>

        <SearchPaletteFooter
          hint={
            commandsMode
              ? 'Backspace at start clears > and returns to search'
              : 'Press ⌘K anywhere to summon'
          }
        />
      </div>
    </div>
  );

  // Mount via portal so overlay escapes the layout stacking context
  if (typeof document === 'undefined') return null;
  return createPortal(palette, document.body);
}
