// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Stylized SVG glyph representing printer kind (fdm / resin).
// a11y: role="img" + aria-label since the glyph conveys the printer category.

import { printerGlyphKind, printerKindLabel } from './forge-labels';

interface PrinterGlyphProps {
  kind: string;
  size?: number;
  /** Tailwind stroke colour class, e.g. 'text-fg-muted'. Applied via currentColor. */
  colorClass?: string;
}

export function PrinterGlyph({ kind, size = 42, colorClass = 'text-fg-muted' }: PrinterGlyphProps) {
  const glyphKind = printerGlyphKind(kind);
  const label = printerKindLabel(kind);

  if (glyphKind === 'resin') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 42 42"
        fill="none"
        role="img"
        aria-label={label}
        className={colorClass}
      >
        <rect x="7" y="5" width="28" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M10 14v22c0 2.2 1.8 4 4 4h14c2.2 0 4-1.8 4-4V14"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
        />
        <path
          d="M17 26l4 5 4-5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M13 18h16" stroke="currentColor" strokeWidth="0.8" strokeDasharray="2 2" />
      </svg>
    );
  }

  // fdm (default)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 42 42"
      fill="none"
      role="img"
      aria-label={label}
      className={colorClass}
    >
      <rect x="5" y="8" width="32" height="20" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11" y="28" width="20" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="30" cy="16" r="1.2" fill="currentColor" />
      <path d="M11 14h8M11 18h5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
