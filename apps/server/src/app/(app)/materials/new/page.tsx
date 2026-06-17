// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// /materials/new — add material flow, manual (path A) only.
// Canvas: MatAddFlow (page-materials.jsx line 359-415).
// Paths B (barcode) and C (receipt) are deferred canvas features.

import Link from 'next/link';
import { SectionTitle } from '@/components/shell/atoms';
import { MaterialAddForm } from '@/components/materials/MaterialAddForm';

export default function MaterialNewPage() {
  return (
    <div>
      {/* Breadcrumb */}
      <div className="mb-2 flex items-baseline gap-3.5">
        <Link
          href="/materials"
          className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint hover:text-fg-muted"
        >
          Workshop
        </Link>
        <span className="font-mono text-[10px] text-fg-faint">›</span>
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Add
        </span>
        <span className="flex-1 border-b border-hairline" />
      </div>

      {/* Page header */}
      <h1 className="m-0 mb-1.5 font-serif text-[44px] font-normal leading-[1.02] tracking-[-1.1px] text-fg">
        How will you tell us about it?
      </h1>
      <p className="mb-[22px] font-serif text-[16px] italic text-fg-muted">
        Three doors to the same form. Pick whichever the spool lets you.
      </p>

      {/* Path cards */}
      <div className="mb-6 grid grid-cols-3 gap-3.5">
        {[
          {
            kw: 'A · Manual',
            title: 'Type it in',
            body: 'Brand, line, color, type, weight. Best for old spools and one-offs.',
            cta: 'Begin manual',
            best: false,
            active: true,
          },
          {
            kw: 'B · Barcode',
            title: 'Scan the spool',
            body: 'Camera or USB barcode reader. We pull brand + line from the catalogue, you confirm color and weight.',
            cta: 'Open scanner',
            best: true,
            active: false,
          },
          {
            kw: 'C · Receipt',
            title: 'Drop your invoice',
            body: 'PDF or image. We OCR the line items, propose one row per spool, you pick which to add.',
            cta: 'Drop receipt',
            best: false,
            active: false,
          },
        ].map((p) => (
          <div
            key={p.kw}
            className={`flex flex-col gap-3.5 rounded-lg border p-[22px] ${
              p.best
                ? 'border-accent-edge bg-accent-soft'
                : 'border-hairline bg-surface'
            } ${!p.active ? 'opacity-55' : ''}`}
          >
            <div
              className={`font-mono text-[9.5px] uppercase tracking-[1.4px] ${
                p.best ? 'text-accent' : 'text-fg-faint'
              }`}
            >
              {p.kw}
            </div>
            <div className="font-serif text-[28px] leading-[1.05] tracking-[-0.6px] text-fg">
              {p.title}
            </div>
            <div className="font-serif text-[14px] italic leading-[1.45] text-fg-muted">
              {p.body}
            </div>
            <button
              type="button"
              disabled={!p.active}
              className={`rounded-md px-3.5 py-2 font-sans text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                p.best
                  ? 'bg-accent text-accent-ink'
                  : 'border border-hairline bg-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {p.cta} →
            </button>
          </div>
        ))}
      </div>

      {/* Manual form */}
      <SectionTitle meta="path A · the canonical form">Step 2 · fill the line</SectionTitle>
      <MaterialAddForm />
    </div>
  );
}
