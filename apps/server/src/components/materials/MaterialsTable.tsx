// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// MaterialsTable — dense ledger table for the inventory list.
// Canvas reference: MatInventoryLedger table section (page-materials.jsx line 186-237).

import Link from 'next/link';
import { MetaBadge, type Tone } from '@/components/shell/atoms';
import { relativeAge } from '@/lib/time';
import { materialDisplayName, kindLabel, unitLabel } from './materials-labels';
import { RemainingBar } from './RemainingBar';

interface MaterialDto {
  id: string;
  kind: string;
  brand: string | null;
  subtype: string | null;
  colorName: string | null;
  colors: string[] | null;
  initialAmount: number;
  remainingAmount: number;
  unit: string;
  active: boolean;
  loadedInPrinterId: string | null;
  retirementReason: string | null;
  createdAt: string;
}

function statusTone(m: MaterialDto): Tone {
  if (!m.active) return 'neutral';
  if (m.loadedInPrinterId) return 'accent';
  if (m.remainingAmount === 0) return 'running';
  const pct = m.initialAmount === 0 ? 1 : m.remainingAmount / m.initialAmount;
  if (pct < 0.2) return 'running';
  return 'neutral';
}

function statusLabel(m: MaterialDto): string {
  if (!m.active) return 'retired';
  if (m.loadedInPrinterId) return 'loaded';
  if (m.remainingAmount === 0) return 'empty';
  const pct = m.initialAmount === 0 ? 1 : m.remainingAmount / m.initialAmount;
  if (pct < 0.1) return 'critical';
  if (pct < 0.2) return 'low';
  return 'active';
}

export function MaterialsTable({ materials }: { materials: MaterialDto[] }) {
  if (materials.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
      {/* Header */}
      <div
        className="grid items-center gap-3 border-b border-hairline bg-surface-2 px-[14px] py-[10px] font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint"
        style={{ gridTemplateColumns: '24px 28px 1.7fr 100px 1fr 130px 80px 70px' }}
      >
        <span />
        <span />
        <span>Material</span>
        <span>Kind</span>
        <span>Printer</span>
        <span>Amount</span>
        <span>Age</span>
        <span className="text-right">Status</span>
      </div>

      {materials.map((m, idx) => {
        const isRetired = !m.active;
        const swatchColor = m.colors?.[0] ?? '#888';
        const isLast = idx === materials.length - 1;

        return (
          <Link
            key={m.id}
            href={`/materials/${m.id}`}
            className={`grid items-center gap-3 px-[14px] py-[10px] text-[12.5px] transition-colors hover:bg-surface-hi ${isRetired ? 'opacity-55' : ''} ${isLast ? '' : 'border-b border-dashed border-hairline'}`}
            style={{ gridTemplateColumns: '24px 28px 1.7fr 100px 1fr 130px 80px 70px' }}
          >
            {/* Checkbox placeholder */}
            <span className="h-3.5 w-3.5 rounded-[3px] border border-hairline bg-surface-2" />

            {/* Color swatch */}
            <span
              className="h-[18px] w-[18px] rounded-full border border-hairline"
              style={{ background: swatchColor }}
            />

            {/* Name */}
            <span className="font-sans text-fg">
              {materialDisplayName(m)}
              {m.brand && (
                <span className="ml-2 font-mono text-[10px] text-fg-faint">· {m.brand}</span>
              )}
              {isRetired && m.retirementReason && (
                <span className="ml-2 font-serif text-[11.5px] italic text-fg-faint">
                  · retired ({m.retirementReason})
                </span>
              )}
            </span>

            {/* Kind */}
            <span className="font-mono text-[11px] text-fg-muted">
              {kindLabel(m.kind)}
            </span>

            {/* Printer */}
            {/* TODO(materials-printer-lookup): resolve printer name from
                loadedInPrinterId via /api/v1/forge/printers query (fetched
                once at page-level, then threaded as a name-map into the
                table to avoid N+1). For now we show the literal "loaded"
                affordance — the detail page resolves the name. */}
            <span
              className={`font-mono text-[11px] ${m.loadedInPrinterId ? 'text-accent' : 'text-fg-faint'}`}
            >
              {m.loadedInPrinterId ? `loaded` : '— shelf —'}
            </span>

            {/* Amount + bar */}
            <span>
              <RemainingBar
                remainingAmount={m.remainingAmount}
                initialAmount={m.initialAmount}
                unit={unitLabel(m.unit)}
              />
            </span>

            {/* Age */}
            <span className="font-serif text-[12.5px] italic text-fg-muted">
              {relativeAge(new Date(m.createdAt))}
            </span>

            {/* Status badge */}
            <span className="text-right">
              <MetaBadge tone={statusTone(m)}>{statusLabel(m)}</MetaBadge>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
