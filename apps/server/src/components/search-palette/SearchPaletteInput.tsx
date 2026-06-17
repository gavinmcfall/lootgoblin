// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// SearchPaletteInput — top input row with prefix indicator, scope badge, mode badge.
// Canvas reference: CKInput (page-search-palette.jsx line 107–136).

import type { KeyboardEvent, RefObject } from 'react';
import { MetaBadge } from '@/components/shell/atoms';

interface SearchPaletteInputProps {
  inputRef: RefObject<HTMLInputElement | null>;
  inputId: string;
  labelId: string;
  /** id of the listbox element this input controls — required for ARIA combobox spec. */
  listboxId: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Shown when in commands mode (> prefix) */
  commandsMode?: boolean;
  /** Optional scope label (e.g. "In: Library X") — deferred (Scoped variant) */
  scope?: string;
  onClearScope?: () => void;
  activeDescendant?: string;
}

export function SearchPaletteInput({
  inputRef,
  inputId,
  labelId,
  listboxId,
  value,
  onChange,
  onKeyDown,
  commandsMode = false,
  scope,
  onClearScope,
  activeDescendant,
}: SearchPaletteInputProps) {
  return (
    <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3.5">
      {/* Scope badge */}
      {scope && (
        <MetaBadge tone="accent">
          {scope}
          <button
            type="button"
            onClick={onClearScope}
            className="ml-1.5 opacity-60 hover:opacity-100"
            aria-label={`Clear scope: ${scope}`}
          >
            ✕
          </button>
        </MetaBadge>
      )}

      {/* Prefix / magnifier */}
      {commandsMode ? (
        <span className="font-mono text-[15px] font-semibold text-accent">&gt;</span>
      ) : (
        <span className="text-[18px] text-fg-faint" aria-hidden="true">⌕</span>
      )}

      {/* Hidden label for AT */}
      <label id={labelId} htmlFor={inputId} className="sr-only">
        {commandsMode ? 'Command search' : 'Search the hoard'}
      </label>

      <input
        ref={inputRef}
        id={inputId}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          commandsMode
            ? 'Type a command…'
            : 'Search the hoard, or type > for commands…'
        }
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={true}
        aria-activedescendant={activeDescendant}
        className="flex-1 border-none bg-transparent font-sans text-[17px] text-fg placeholder:text-fg-faint focus:outline-none"
      />

      {/* Mode badge */}
      {commandsMode && (
        <MetaBadge tone="accent">Commands</MetaBadge>
      )}
    </div>
  );
}
