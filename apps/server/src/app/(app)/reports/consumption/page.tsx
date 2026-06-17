// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// /reports/consumption — Consumption dashboard.
// Analyst view (multi-panel grid) or Story view (narrated month).
// Canvas ref: ConsumptionDashAnalyst (line 59) + ConsumptionDashStory (line 265).
// View mode is toggled inline — no separate route.

import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { EmptyHint, MetaBadge, SectionTitle, Tile, type Tone } from '@/components/shell/atoms';
import { ConsumptionRangePicker } from '@/components/reports/ConsumptionRangePicker';
import { ProvenanceBar } from '@/components/reports/ProvenanceBar';
import { ProvenanceStack } from '@/components/reports/ProvenanceStack';
import { MonthChart } from '@/components/reports/MonthChart';
import { BrandBars } from '@/components/reports/BrandBars';
import { PrinterTable } from '@/components/reports/PrinterTable';
import { ColorBubbles } from '@/components/reports/ColorBubbles';
import {
  rangeWindow,
  fmtKg,
  estimatedFraction,
  type RangePreset,
} from '@/components/reports/reports-labels';
import type { ProvenanceBreakdown } from '@/materials/reports';

// ── DTO types (mirrors route.ts responses) ─────────────────────────────────

interface ConsumptionRow<TKey> {
  key: TKey;
  totalAmount: number;
  unit: string;
  provenance: ProvenanceBreakdown;
  eventCount: number;
}

interface MultiResponse<TKey> {
  dimension: string;
  window: { since: string; until: string };
  rows: ConsumptionRow<TKey>[];
}

interface TotalResponse {
  dimension: 'total';
  window: { since: string; until: string };
  row: ConsumptionRow<Record<string, never>>;
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchDimension<TKey>(
  dimension: string,
  since: string,
  until: string,
): Promise<MultiResponse<TKey>> {
  const url = `/api/v1/reports/consumption?dimension=${dimension}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<MultiResponse<TKey>>;
}

async function fetchTotal(since: string, until: string): Promise<TotalResponse> {
  const url = `/api/v1/reports/consumption?dimension=total&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<TotalResponse>;
}

// ── Build 12-month windows (most-recent month last) ─────────────────────────

function buildMonthWindows(): Array<{ since: string; until: string; label: string }> {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const until = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i + 1, 1));
    const since = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    const label = since.toLocaleString('en', { month: 'short' });
    months.push({ since: since.toISOString(), until: until.toISOString(), label });
  }
  return months;
}

const MONTH_WINDOWS = buildMonthWindows();

// ── View-mode toggle ─────────────────────────────────────────────────────────

type ViewMode = 'analyst' | 'story';

// ── Page ────────────────────────────────────────────────────────────────────

export default function ConsumptionPage() {
  const [range, setRange] = useState<RangePreset>('30d');
  const [view, setView] = useState<ViewMode>('analyst');

  const { since, until } = useMemo(() => rangeWindow(range), [range]);

  // ── Dimension queries ──────────────────────────────────────────────────────

  const totalQ = useQuery({
    queryKey: ['consumption', 'total', since, until],
    queryFn: () => fetchTotal(since, until),
  });

  const brandQ = useQuery({
    queryKey: ['consumption', 'brand', since, until],
    queryFn: () => fetchDimension<{ brand: string | null }>('brand', since, until),
  });

  const colorQ = useQuery({
    queryKey: ['consumption', 'color', since, until],
    queryFn: () => fetchDimension<{ primaryColor: string | null }>('color', since, until),
  });

  const printerQ = useQuery({
    queryKey: ['consumption', 'printer', since, until],
    queryFn: () => fetchDimension<{ printerRef: string | null }>('printer', since, until),
  });

  // ── 12-month parallel queries (time-series workaround) ────────────────────
  // TODO(consumption-time-series): backend has no time-bucket dimension yet.
  // Currently firing 12 parallel queries (1 per month) — wasteful but functional.
  // Future V2-007a follow-up: add /api/v1/reports/consumption?dimension=month
  // or ?bucketBy=month to return all 12 in one call.
  const monthQueries = useQueries({
    queries: MONTH_WINDOWS.map((w) => ({
      queryKey: ['consumption', 'total', w.since, w.until],
      queryFn: () => fetchTotal(w.since, w.until),
    })),
  });

  // ── Loading / error states ─────────────────────────────────────────────────

  const mainLoading =
    totalQ.isLoading || brandQ.isLoading || colorQ.isLoading || printerQ.isLoading;
  const mainError =
    totalQ.isError || brandQ.isError || colorQ.isError || printerQ.isError;
  const monthsLoading = monthQueries.some((q) => q.isLoading);
  const monthsError = monthQueries.some((q) => q.isError);

  if (mainError) return <EmptyHint>Failed to load consumption data.</EmptyHint>;
  if (mainLoading) return <EmptyHint>Loading consumption data…</EmptyHint>;

  // ── Derived data ───────────────────────────────────────────────────────────

  const totalRow = totalQ.data!.row;
  const totalKg = totalRow.totalAmount / 1000; // grams → kg
  const provenance = totalRow.provenance;
  const eventCount = totalRow.eventCount;
  const estFrac = estimatedFraction(provenance);
  const provTone: Tone = estFrac < 0.3 ? 'success' : 'running';

  const brandRows = (brandQ.data?.rows ?? [])
    .filter((r) => r.totalAmount > 0)
    .map((r) => ({ name: r.key.brand ?? 'Unknown', mass: r.totalAmount / 1000 }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 8);

  const colorRows = (colorQ.data?.rows ?? [])
    .filter((r) => r.totalAmount > 0)
    .map((r) => ({ hex: r.key.primaryColor ?? '#888888', mass: r.totalAmount / 1000, name: r.key.primaryColor ?? 'Unknown' }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 6);

  const totalPrinterMass = (printerQ.data?.rows ?? []).reduce((s, r) => s + r.totalAmount, 0);
  const printerRows = (printerQ.data?.rows ?? [])
    .filter((r) => r.totalAmount > 0)
    .map((r) => ({
      name: r.key.printerRef ?? 'Unknown printer',
      mass: r.totalAmount / 1000,
      prints: r.eventCount,
      share: totalPrinterMass > 0 ? r.totalAmount / totalPrinterMass : 0,
    }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 8);

  // 12-month time series
  const monthData = monthsLoading
    ? null
    : MONTH_WINDOWS.map((w, i) => {
        const row = monthQueries[i]?.data?.row;
        const mass = (row?.totalAmount ?? 0) / 1000;
        const p = row?.provenance;
        const est = p
          ? (p.estimated + p.derived + p.computed + p.system) / 1000
          : 0;
        return { m: w.label, mass, est };
      });

  // Range label for masthead
  const rangeLabel =
    range === '30d' ? 'last 30 days' : range === '90d' ? 'last 90 days' : 'last 12 months';

  // ── Masthead (shared between views) ─────────────────────────────────────────

  const Masthead = (
    <div className="mb-4">
      <div className="mb-2 flex items-baseline gap-3.5">
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Consumption · {rangeLabel}
        </span>
        <span className="flex-1 border-b border-hairline" />
        {/* View-mode toggle */}
        <div
          className="flex gap-1 rounded-full border border-hairline bg-surface-2 p-[3px]"
          role="group"
          aria-label="View mode"
        >
          {(['analyst', 'story'] as ViewMode[]).map((m) => {
            const active = view === m;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={active}
                onClick={() => setView(m)}
                className={`rounded-full border px-[10px] py-1 font-mono text-[10px] capitalize tracking-[0.4px] transition-colors ${
                  active
                    ? 'border-hairline bg-surface text-fg'
                    : 'border-transparent bg-transparent text-fg-muted hover:text-fg'
                }`}
              >
                {m}
              </button>
            );
          })}
        </div>
        <ConsumptionRangePicker value={range} onChange={setRange} />
      </div>
      <h1 className="m-0 font-serif text-[52px] font-normal leading-none tracking-[-1.5px] text-fg">
        {fmtKg(totalRow.totalAmount)} kg burned.
      </h1>
      <p className="mt-1 font-serif text-[17px] italic text-fg-muted">
        {eventCount} print{eventCount !== 1 ? 's' : ''} · across {printerRows.length} printer{printerRows.length !== 1 ? 's' : ''}
      </p>
    </div>
  );

  // ── Analyst view ─────────────────────────────────────────────────────────────

  if (view === 'analyst') {
    return (
      <div>
        {Masthead}
        <ProvenanceBar provenance={provenance} />

        {/* Top row: By month + By brand */}
        <div className="mt-4 grid gap-4" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
          {/* By month */}
          <Tile className="p-5">
            <SectionTitle meta="kg / month · est. shaded">By month</SectionTitle>
            {monthsError ? (
              <EmptyHint>Failed to load time series.</EmptyHint>
            ) : !monthData ? (
              <EmptyHint>Loading time series…</EmptyHint>
            ) : (
              <>
                <MonthChart data={monthData} h={220} />
                <div className="mt-3.5 flex flex-wrap gap-6 font-mono text-[10.5px] text-fg-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-[10px] w-[10px] rounded-[2px] bg-fg opacity-80" />
                    measured
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-[10px] w-[10px] rounded-[2px] opacity-45" style={{ background: 'var(--running)' }} />
                    estimated by slicer
                  </span>
                </div>
              </>
            )}
          </Tile>

          {/* By brand */}
          <Tile className="p-5">
            <SectionTitle meta={`${rangeLabel} · kg`}>By brand</SectionTitle>
            {brandRows.length === 0 ? (
              <EmptyHint>No brand data for this period.</EmptyHint>
            ) : (
              <BrandBars data={brandRows} />
            )}
          </Tile>
        </div>

        {/* Bottom row: By printer + By colour */}
        <div className="mt-4 grid gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {/* By printer */}
          <Tile className="p-5">
            <SectionTitle meta="kg · prints · share">By printer</SectionTitle>
            {printerRows.length === 0 ? (
              <EmptyHint>No printer data for this period.</EmptyHint>
            ) : (
              <PrinterTable data={printerRows} />
            )}
          </Tile>

          {/* By colour */}
          <Tile className="p-5">
            <SectionTitle meta="top 6 spool hexes consumed">By colour</SectionTitle>
            {colorRows.length === 0 ? (
              <EmptyHint>No colour data for this period.</EmptyHint>
            ) : (
              <ColorBubbles data={colorRows} />
            )}
          </Tile>
        </div>
      </div>
    );
  }

  // ── Story view ───────────────────────────────────────────────────────────────

  const peakMonth = monthData
    ? monthData.reduce(
        (best, d) => (best === undefined || d.mass > best.mass ? d : best),
        undefined as (typeof monthData)[number] | undefined,
      )
    : null;
  const lowMonth = monthData
    ? monthData.reduce(
        (best, d) => (best === undefined || d.mass < best.mass ? d : best),
        undefined as (typeof monthData)[number] | undefined,
      )
    : null;

  return (
    <div>
      {Masthead}

      <div className="mt-4 grid gap-7" style={{ gridTemplateColumns: '1.55fr 1fr' }}>
        {/* Lede column */}
        <div>
          {/* Big sentence */}
          <p className="m-0 font-serif text-[17px] italic leading-[1.45] text-fg-muted">
            {printerRows[0] != null
              ? `Most of it ran through ${printerRows[0].name}.`
              : 'No printer data for this period.'}{' '}
            <MetaBadge tone={provTone}>
              {estFrac < 0.3 ? 'mostly measured' : 'mostly estimated'}
            </MetaBadge>
          </p>

          {/* Year-shape chart */}
          <Tile className="mt-7 p-5">
            <SectionTitle meta="kg / month">The shape of the year</SectionTitle>
            {monthsError ? (
              <EmptyHint>Failed to load time series.</EmptyHint>
            ) : !monthData ? (
              <EmptyHint>Loading time series…</EmptyHint>
            ) : (
              <>
                <MonthChart data={monthData} h={240} />
                <div className="mt-3.5 flex flex-wrap gap-6 font-mono text-[10.5px] text-fg-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-[10px] w-[10px] rounded-[2px] bg-fg opacity-80" />
                    measured
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-[10px] w-[10px] rounded-[2px] opacity-45" style={{ background: 'var(--running)' }} />
                    estimated by slicer
                  </span>
                  {peakMonth && lowMonth && (
                    <span className="ml-auto">
                      peak{' '}
                      <span className="text-fg">
                        {peakMonth.m} · {peakMonth.mass.toFixed(2)} kg
                      </span>{' '}
                      · low{' '}
                      <span className="text-fg">
                        {lowMonth.m} · {lowMonth.mass.toFixed(2)} kg
                      </span>
                    </span>
                  )}
                </div>
              </>
            )}
          </Tile>

          {/* Printer + colour pair */}
          <div className="mt-4 grid gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Tile className="p-5">
              <SectionTitle meta="kg · share">By printer</SectionTitle>
              {printerRows.length === 0 ? (
                <EmptyHint>No printer data for this period.</EmptyHint>
              ) : (
                <PrinterTable data={printerRows} />
              )}
            </Tile>
            <Tile className="p-5">
              <SectionTitle meta="top 4 hexes">By colour</SectionTitle>
              {colorRows.length === 0 ? (
                <EmptyHint>No colour data for this period.</EmptyHint>
              ) : (
                <ColorBubbles data={colorRows.slice(0, 4)} />
              )}
            </Tile>
          </div>
        </div>

        {/* Story sidebar */}
        <aside className="flex flex-col gap-4">
          {/* By brand */}
          <Tile className="p-4">
            <SectionTitle meta={rangeLabel}>By brand</SectionTitle>
            {brandRows.length === 0 ? (
              <EmptyHint>No brand data for this period.</EmptyHint>
            ) : (
              <BrandBars data={brandRows} />
            )}
          </Tile>

          {/* Provenance this period */}
          <Tile className="p-4">
            <div className="mb-2.5 font-mono text-[9.5px] uppercase tracking-[1.6px] text-fg-faint">
              Provenance · this period
            </div>
            <ProvenanceStack provenance={provenance} />
            <p className="mt-2.5 font-serif text-[13.5px] italic leading-[1.45] text-fg-muted">
              {Math.round((provenance.measured / (totalRow.totalAmount || 1)) * 100)}% of mass
              came from scale readings.{' '}
              {estFrac > 0 && `${Math.round(estFrac * 100)}% was estimated or derived.`}
            </p>
          </Tile>
        </aside>
      </div>
    </div>
  );
}
