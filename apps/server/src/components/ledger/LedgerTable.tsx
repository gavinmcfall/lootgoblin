'use client';

import { LedgerRow } from './LedgerRow';
import type { LedgerEventDto } from './types';

interface Props {
  events: LedgerEventDto[];
}

/**
 * Table of ledger events with a sticky-feeling header strip. Rows are
 * full-width links to the detail page.
 */
export function LedgerTable({ events }: Props) {
  return (
    <div className="rounded-md border border-hairline bg-surface">
      <div className="grid grid-cols-[80px_minmax(140px,1fr)_minmax(160px,1.2fr)_120px_minmax(160px,2fr)] items-baseline gap-3 border-b-2 border-fg px-2 py-2">
        <Th>when</Th>
        <Th>kind</Th>
        <Th>subject</Th>
        <Th>actor</Th>
        <Th>payload</Th>
      </div>
      <div>
        {events.map((ev) => (
          <LedgerRow key={ev.id} event={ev} />
        ))}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
      {children}
    </span>
  );
}
