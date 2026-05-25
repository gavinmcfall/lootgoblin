'use client';
// /materials — inventory ledger page.
// Canvas: MatInventoryLedger (page-materials.jsx line 179-240).

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { EmptyHint } from '@/components/shell/atoms';
import { MaterialsFilters } from '@/components/materials/MaterialsFilters';
import { MaterialsTable } from '@/components/materials/MaterialsTable';

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

export default function MaterialsPage() {
  const [kindFilter, setKindFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');

  const params = new URLSearchParams();
  if (kindFilter) params.set('kind', kindFilter);
  if (stateFilter === 'active') params.set('active', 'true');
  if (stateFilter === 'retired') params.set('active', 'false');
  const queryString = params.toString();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['materials', kindFilter, stateFilter],
    queryFn: async (): Promise<{ materials: MaterialDto[] }> =>
      (await fetch(`/api/v1/materials${queryString ? `?${queryString}` : ''}`)).json(),
  });

  if (isError) return <EmptyHint>Failed to load materials.</EmptyHint>;
  if (isLoading) return <EmptyHint>Loading materials…</EmptyHint>;

  const materials = data?.materials ?? [];

  return (
    <div>
      {/* Breadcrumb bar */}
      <div className="mb-2 flex items-baseline gap-3.5">
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Inventory
        </span>
        <span className="flex-1 border-b border-hairline" />
        <span className="font-mono text-[10px] text-fg-faint">
          {`${materials.length} lines`}
        </span>
      </div>

      {/* Page header */}
      <div className="mb-[22px] flex items-end gap-4">
        <div className="flex-1">
          <h1 className="m-0 font-serif text-[48px] font-normal leading-none tracking-[-1.4px] text-fg">
            The Workshop.
          </h1>
          <p className="mt-1.5 font-serif text-[16px] italic text-fg-muted">
            filament · resin · mixes — what&apos;s in the workshop right now.
          </p>
        </div>
        <Link
          href="/materials/mix"
          className="rounded-md border border-hairline px-3.5 py-2 font-sans text-[12.5px] text-fg-muted hover:text-fg"
        >
          Guided mix
        </Link>
        <Link
          href="/materials/new"
          className="rounded-md bg-accent px-3.5 py-2 font-sans text-[12.5px] font-semibold text-accent-ink"
        >
          + Add material
        </Link>
      </div>

      <MaterialsFilters
        kind={kindFilter}
        state={stateFilter}
        onKind={setKindFilter}
        onState={setStateFilter}
      />

      {materials.length === 0 ? (
        <EmptyHint>
          No materials found. Add your first spool or bottle to get started.
        </EmptyHint>
      ) : (
        <MaterialsTable materials={materials} />
      )}
    </div>
  );
}
