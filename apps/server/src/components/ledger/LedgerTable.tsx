// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';

import { LedgerRow } from './LedgerRow';
import type { LedgerEventDto } from './types';

interface Props {
  events: LedgerEventDto[];
}

// Shared column template — applied to both the header row and each LedgerRow
// via `display: grid` so the semantic <table>/<tr>/<th>/<td> layout matches
// the visual grid the design calls for.
export const LEDGER_GRID_COLS =
  'grid grid-cols-[80px_minmax(140px,1fr)_minmax(160px,1.2fr)_120px_minmax(160px,2fr)] items-baseline gap-3';

/**
 * Table of ledger events with a sticky-feeling header strip. Uses real
 * <table>/<thead>/<tbody>/<tr>/<th>/<td> so screen readers announce row +
 * column structure; the visual grid layout is achieved by applying
 * `display: grid` to <tr> via Tailwind utilities.
 *
 * Each row is keyboard-activatable and routes to /ledger/[id] on click /
 * Enter / Space — wrapping <tr> contents in a <Link> would produce invalid
 * HTML (anchor as a tr child).
 */
export function LedgerTable({ events }: Props) {
  return (
    <table className="w-full rounded-md border border-hairline bg-surface border-separate border-spacing-0">
      <thead>
        <tr className={`${LEDGER_GRID_COLS} border-b-2 border-fg px-2 py-2`}>
          <Th>when</Th>
          <Th>kind</Th>
          <Th>subject</Th>
          <Th>actor</Th>
          <Th>payload</Th>
        </tr>
      </thead>
      <tbody>
        {events.map((ev) => (
          <LedgerRow key={ev.id} event={ev} />
        ))}
      </tbody>
    </table>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="text-left font-mono text-[9.5px] font-normal uppercase tracking-[1.2px] text-fg-faint"
    >
      {children}
    </th>
  );
}
