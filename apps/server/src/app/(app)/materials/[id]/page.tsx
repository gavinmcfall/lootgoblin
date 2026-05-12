'use client';
// /materials/[id] — spool detail page with retire dialog.
// Canvas: SpoolDetailPage (page-materials.jsx line 243-356) + RetireDialog.

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { EmptyHint, KV, MetaBadge, SectionTitle } from '@/components/shell/atoms';
import { MaterialCard } from '@/components/materials/MaterialCard';
import { RetireDialog } from '@/components/materials/RetireDialog';
import { RemainingBar } from '@/components/materials/RemainingBar';
import { materialDisplayName, kindLabel, unitLabel, colorPatternLabel } from '@/components/materials/materials-labels';
import { relativeAge } from '@/lib/time';

interface MaterialDto {
  id: string;
  ownerId: string;
  kind: string;
  brand: string | null;
  subtype: string | null;
  colorName: string | null;
  colors: string[] | null;
  colorPattern: string | null;
  density: number | null;
  initialAmount: number;
  remainingAmount: number;
  unit: string;
  purchaseData: Record<string, unknown> | null;
  loadedInPrinterId: string | null;
  active: boolean;
  retirementReason: string | null;
  retiredAt: string | null;
  extra: Record<string, unknown> | null;
  createdAt: string;
  productId: string | null;
}

export default function MaterialDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [retireOpen, setRetireOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['material', id],
    queryFn: async (): Promise<{ material: MaterialDto }> =>
      (await fetch(`/api/v1/materials/${id}`)).json(),
    enabled: !!id,
  });

  if (isError) return <EmptyHint>Failed to load material.</EmptyHint>;
  if (isLoading) return <EmptyHint>Loading…</EmptyHint>;

  const m = data?.material;
  if (!m) return <EmptyHint>Material not found.</EmptyHint>;

  const displayName = materialDisplayName(m);
  const pct = m.initialAmount === 0 ? 0 : Math.round((m.remainingAmount / m.initialAmount) * 100);

  return (
    <div>
      {/* Breadcrumb bar */}
      <div className="mb-2.5 flex items-baseline gap-3.5">
        <Link
          href="/materials"
          className="font-mono text-[10px] uppercase tracking-[1.4px] text-fg-faint hover:text-fg-muted"
        >
          Workshop
        </Link>
        <span className="font-mono text-[10px] text-fg-faint">›</span>
        <span className="font-mono text-[10px] uppercase tracking-[1.4px] text-fg-faint">
          {m.id}
        </span>
        <span className="flex-1 border-b border-dashed border-hairline" />
        {!m.active && (
          <MetaBadge tone="neutral">retired</MetaBadge>
        )}
        {m.active && (
          <button
            type="button"
            onClick={() => setRetireOpen(true)}
            className="rounded-sm border border-hairline px-2.5 py-[5px] font-mono text-[9.5px] uppercase tracking-[1px] text-fg-muted hover:text-fg"
          >
            Retire
          </button>
        )}
      </div>

      {/* Three-col layout — matches canvas SpoolDetailPage */}
      <div className="grid gap-[22px]" style={{ gridTemplateColumns: '300px 1fr 280px' }}>
        {/* Left — hero card */}
        <div>
          <MaterialCard material={m} size="lg" />

          {/* Extra meta */}
          <div className="mt-3.5 space-y-1">
            {m.colors && m.colors.length > 0 && (
              <div className="font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
                Swatch · {m.colors.join(', ')}
              </div>
            )}
            {m.colorPattern && (
              <div className="font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
                Pattern · {colorPatternLabel(m.colorPattern)}
              </div>
            )}
            {m.productId && (
              <div className="font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
                Product ID · {m.productId}
              </div>
            )}
          </div>
        </div>

        {/* Middle — identity + stats */}
        <div>
          <div className="font-serif text-[44px] font-normal leading-[1.02] tracking-[-1.1px] text-fg">
            {displayName}.
          </div>
          <div className="mt-1.5 font-serif text-[17px] italic text-fg-muted">
            {[m.brand, m.subtype, kindLabel(m.kind)].filter(Boolean).join(' · ')}
            {m.loadedInPrinterId && ` · loaded`}
            {!m.active && m.retirementReason && ` · retired (${m.retirementReason})`}
          </div>

          {/* Stat strip */}
          <div className="mt-[18px] grid grid-cols-3 gap-2.5">
            {[
              {
                kw: 'Remaining',
                v: `${m.remainingAmount}${unitLabel(m.unit)}`,
                sub: `${pct}% of initial`,
              },
              {
                kw: 'Initial',
                v: `${m.initialAmount}${unitLabel(m.unit)}`,
                sub: kindLabel(m.kind),
              },
              {
                kw: 'Age',
                v: relativeAge(new Date(m.createdAt)),
                sub: new Date(m.createdAt).toLocaleDateString(),
              },
            ].map((s) => (
              <div
                key={s.kw}
                className="rounded-md border border-hairline bg-surface p-3"
              >
                <div className="font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint">
                  {s.kw}
                </div>
                <div className="mt-0.5 font-serif text-[22px] tracking-[-0.4px] text-fg">
                  {s.v}
                </div>
                <div className="mt-1 font-mono text-[9.5px] text-fg-faint">{s.sub}</div>
              </div>
            ))}
          </div>

          {/* Remaining bar (large) */}
          <div className="mt-4">
            <RemainingBar
              remainingAmount={m.remainingAmount}
              initialAmount={m.initialAmount}
              unit={unitLabel(m.unit)}
            />
          </div>

          {/* Loadout status */}
          <div className="mt-5">
            <SectionTitle as="h3" meta="current">Loadout</SectionTitle>
            {m.loadedInPrinterId ? (
              <div className="flex items-center gap-2 rounded-sm border border-accent-edge bg-accent-soft px-3 py-2">
                <span className="h-2 w-2 rounded-full bg-accent" />
                <span className="font-mono text-[11px] tracking-[0.6px] text-accent">
                  Loaded in printer {m.loadedInPrinterId}
                </span>
              </div>
            ) : (
              <EmptyHint>
                {m.active ? 'Not currently loaded in any printer.' : 'Retired — no active loadout.'}
              </EmptyHint>
            )}
          </div>

          {/* Consumption history placeholder */}
          <div className="mt-5">
            <SectionTitle as="h3" meta="from ledger">
              {/* TODO: wire to /api/v1/reports/consumption once consumption-report canvas-port ships */}
              Consumption
            </SectionTitle>
            <EmptyHint>
              Consumption history available in the Consumption Reports page (coming soon).
            </EmptyHint>
          </div>
        </div>

        {/* Right — provenance */}
        <div className="flex flex-col gap-[18px]">
          <div className="rounded-lg border border-hairline bg-surface p-4">
            <div className="mb-2 font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
              Provenance
            </div>
            <dl>
              <KV k="id" v={m.id} mono />
              {m.brand && <KV k="brand" v={m.brand} />}
              {m.subtype && <KV k="subtype" v={m.subtype} />}
              {m.density != null && (
                <KV k="density" v={`${m.density} g/cm³`} mono />
              )}
              <KV k="created" v={new Date(m.createdAt).toLocaleDateString()} />
              {m.purchaseData && Object.keys(m.purchaseData).length > 0 && (
                <>
                  {(m.purchaseData as Record<string, string>).supplier && (
                    <KV k="supplier" v={String(m.purchaseData.supplier)} />
                  )}
                  {(m.purchaseData as Record<string, string>).lot && (
                    <KV k="lot" v={String(m.purchaseData.lot)} mono />
                  )}
                  {(m.purchaseData as Record<string, string>).cost && (
                    <KV k="cost" v={String(m.purchaseData.cost)} mono />
                  )}
                </>
              )}
            </dl>
          </div>

          {/* Retirement notice */}
          {!m.active && (
            <div className="rounded-lg border border-hairline bg-surface p-4 opacity-75">
              <div className="mb-2 font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
                Retirement
              </div>
              <dl>
                {m.retiredAt && (
                  <KV k="retired" v={new Date(m.retiredAt).toLocaleDateString()} />
                )}
                {m.retirementReason && (
                  <KV k="reason" v={m.retirementReason} />
                )}
              </dl>
            </div>
          )}

          {/* Low stock alert */}
          {m.active && m.remainingAmount > 0 && pct < 20 && (
            <div className="rounded-lg border border-running/55 bg-running-bg p-4">
              <div className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[1.4px] text-running">
                Heads-up
              </div>
              <div className="font-serif text-[16px] leading-[1.2] text-fg">
                {m.remainingAmount}{unitLabel(m.unit)} left.
              </div>
              <div className="mt-1.5 font-serif text-[12.5px] italic text-fg-muted">
                Running low — consider reordering.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* RetireDialog */}
      {retireOpen && (
        <RetireDialog
          materialId={m.id}
          materialName={displayName}
          onClose={() => setRetireOpen(false)}
        />
      )}
    </div>
  );
}
