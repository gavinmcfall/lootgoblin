// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tiny coloured status dot. Pulses when state is 'running'.
// a11y: role="status" + aria-label so screen readers announce state changes.

import type { PrinterState } from './forge-labels';
import { printerStateLabel } from './forge-labels';

const STATE_COLOR: Record<PrinterState, string> = {
  running:  'bg-running',
  queue:    'bg-accent',
  idle:     'bg-success',
  disabled: 'bg-fg-faint',
  error:    'bg-danger',
  offline:  'bg-fg-faint',
  unknown:  'bg-fg-faint',
};

export function PrinterDot({ state }: { state: PrinterState }) {
  const color = STATE_COLOR[state];
  const pulse = state === 'running';

  return (
    <span
      role="status"
      aria-label={`State: ${printerStateLabel(state)}`}
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${color} ${
        pulse ? 'animate-pulse shadow-[0_0_0_3px_color-mix(in_oklch,var(--running)_20%,transparent)]' : ''
      }`}
    />
  );
}
