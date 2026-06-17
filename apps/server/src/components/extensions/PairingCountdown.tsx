// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
import { useEffect, useState } from 'react';

interface PairingCountdownProps {
  /** Total duration in seconds (default: 90) */
  totalSeconds?: number;
  /** Unix timestamp (ms) when the challenge expires */
  expiresAt: number;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Live countdown rendered in mono. Color shifts to running (<10s) and danger (<5s). */
export function PairingCountdown({ expiresAt }: PairingCountdownProps) {
  const remaining = () => Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  const [secs, setSecs] = useState(remaining);

  useEffect(() => {
    setSecs(remaining());
    const id = setInterval(() => {
      const r = remaining();
      setSecs(r);
      if (r <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const colorClass =
    secs < 5
      ? 'text-danger'
      : secs < 10
        ? 'text-running'
        : 'text-accent';

  return (
    <span
      aria-live="polite"
      aria-atomic="true"
      className={`font-mono text-[11px] tracking-[1px] ${colorClass}`}
    >
      {formatCountdown(secs)}
    </span>
  );
}
