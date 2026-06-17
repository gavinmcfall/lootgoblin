// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tag-button glyph — small coin with a serif-S currency mark.
// Source: planning/design-system/lib/tokens.jsx

export function CoinMark({
  size = 12,
  color = 'currentColor',
  className,
}: {
  size?: number;
  color?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.3" />
      <path
        d="M8 4.5v7M5.5 6.5h3.25a1.25 1.25 0 010 2.5H6.5a1.25 1.25 0 000 2.5H9.5"
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
