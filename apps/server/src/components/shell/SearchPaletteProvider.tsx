'use client';
// SearchPaletteProvider — context + global ⌘K / Ctrl+K hotkey listener.
// Wraps the app shell; mounts the SearchPalette portal when open.
// Exports useSearchPalette() for programmatic open/close from other components.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { SearchPalette } from '@/components/search-palette/SearchPalette';

// ── Context ───────────────────────────────────────────────────────────────────

interface SearchPaletteContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const SearchPaletteContext = createContext<SearchPaletteContextValue | null>(
  null,
);

export function useSearchPalette(): SearchPaletteContextValue {
  const ctx = useContext(SearchPaletteContext);
  if (!ctx) {
    throw new Error(
      'useSearchPalette must be used inside <SearchPaletteProvider>',
    );
  }
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

interface SearchPaletteProviderProps {
  children: ReactNode;
}

export function SearchPaletteProvider({
  children,
}: SearchPaletteProviderProps) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // Global ⌘K / Ctrl+K hotkey
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <SearchPaletteContext.Provider value={{ isOpen, open, close }}>
      {children}
      {isOpen && <SearchPalette onClose={close} />}
    </SearchPaletteContext.Provider>
  );
}
