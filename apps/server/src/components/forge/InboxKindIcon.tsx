// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// SVG glyph per file kind. Carries role="img" + aria-label for a11y.

import { fileKindLabel } from './inbox-labels';

interface InboxKindIconProps {
  kind: string;
  size?: number;
}

export function InboxKindIcon({ kind, size = 22 }: InboxKindIconProps) {
  const label = fileKindLabel(kind);

  switch (kind) {
    case 'mini':
      return (
        <svg
          role="img"
          aria-label={label}
          width={size}
          height={size}
          viewBox="0 0 22 22"
          fill="none"
          className="text-fg-muted"
        >
          <circle cx="11" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M11 9v6M7 11l4 4 4-4M8 19h6"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );

    case 'func':
      return (
        <svg
          role="img"
          aria-label={label}
          width={size}
          height={size}
          viewBox="0 0 22 22"
          fill="none"
          className="text-fg-muted"
        >
          <rect x="4" y="7" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4 11h14M11 11v6" stroke="currentColor" strokeWidth="0.9" />
          <circle cx="8" cy="9" r="0.6" fill="currentColor" />
          <circle cx="14" cy="14" r="0.6" fill="currentColor" />
        </svg>
      );

    case 'grid':
      return (
        <svg
          role="img"
          aria-label={label}
          width={size}
          height={size}
          viewBox="0 0 22 22"
          fill="none"
          className="text-fg-muted"
        >
          <rect
            x="3.5"
            y="3.5"
            width="15"
            height="15"
            rx="1"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M3.5 8.5h15M3.5 13.5h15M8.5 3.5v15M13.5 3.5v15"
            stroke="currentColor"
            strokeWidth="0.8"
          />
        </svg>
      );

    default:
      return (
        <svg
          role="img"
          aria-label={label}
          width={size}
          height={size}
          viewBox="0 0 22 22"
          fill="none"
          className="text-fg-muted"
        >
          <circle
            cx="11"
            cy="11"
            r="7"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="2 2"
          />
          <path
            d="M11 7v4M11 14v0.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
