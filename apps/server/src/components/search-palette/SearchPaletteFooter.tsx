'use client';
// SearchPaletteFooter — bottom key-hints strip.
// Canvas reference: CKPaletteFooter (page-search-palette.jsx line 79–105).

import { KbdHint } from './KbdHint';

interface SearchPaletteFooterProps {
  hint?: string;
}

export function SearchPaletteFooter({ hint }: SearchPaletteFooterProps) {
  return (
    <div className="flex items-center gap-3 border-t border-hairline bg-surface-2 px-3.5 py-2">
      <span className="flex items-center gap-1 font-mono text-[10px] text-fg-faint">
        <KbdHint>↑</KbdHint>
        <KbdHint>↓</KbdHint>
        <span className="ml-0.5">navigate</span>
      </span>
      <span className="flex items-center gap-1 font-mono text-[10px] text-fg-faint">
        <KbdHint>⏎</KbdHint>
        <span className="ml-0.5">open</span>
      </span>
      <span className="flex items-center gap-1 font-mono text-[10px] text-fg-faint">
        <KbdHint>&gt;</KbdHint>
        <span className="ml-0.5">commands</span>
      </span>
      <span className="flex-1" />
      {hint && (
        <span className="font-serif text-[11.5px] italic text-fg-muted">
          {hint}
        </span>
      )}
      <KbdHint>esc</KbdHint>
    </div>
  );
}
