'use client';
// /grimoire — unified Grimoire list (slicer profiles + print settings).
// Canvas reference: GrimoireList (page-grimoire.jsx line 38–102).

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { EmptyHint, SectionTitle } from '@/components/shell/atoms';
import { GrimoireTable } from '@/components/grimoire/GrimoireTable';

interface SlicerProfileDto {
  id: string;
  name: string;
  slicerKind: string;
  printerKind: string;
  materialKind: string;
  opaqueUnsupported: boolean;
  createdAt: string;
}

interface PrintSettingDto {
  id: string;
  name: string;
  createdAt: string;
}

type KindFilter = 'all' | 'slicer-profile' | 'print-setting';

export default function GrimoirePage() {
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  const profilesQ = useQuery({
    queryKey: ['slicer-profiles'],
    queryFn: async (): Promise<{ profiles: SlicerProfileDto[] }> =>
      (await fetch('/api/v1/grimoire/slicer-profiles')).json(),
    enabled: kindFilter === 'all' || kindFilter === 'slicer-profile',
  });

  const settingsQ = useQuery({
    queryKey: ['print-settings'],
    queryFn: async (): Promise<{ settings: PrintSettingDto[] }> =>
      (await fetch('/api/v1/grimoire/print-settings')).json(),
    enabled: kindFilter === 'all' || kindFilter === 'print-setting',
  });

  const isError = profilesQ.isError || settingsQ.isError;
  const isLoading = profilesQ.isLoading || settingsQ.isLoading;

  if (isError) return <EmptyHint>Failed to load Grimoire entries.</EmptyHint>;
  if (isLoading) return <EmptyHint>Loading Grimoire…</EmptyHint>;

  const profiles = (profilesQ.data?.profiles ?? []).map((p) => ({
    ...p,
    kind: 'slicer-profile' as const,
  }));
  const settings = (settingsQ.data?.settings ?? []).map((s) => ({
    ...s,
    kind: 'print-setting' as const,
  }));

  const rows = [
    ...(kindFilter !== 'print-setting' ? profiles : []),
    ...(kindFilter !== 'slicer-profile' ? settings : []),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = rows.length;

  return (
    <div>
      {/* Breadcrumb bar */}
      <div className="mb-2 flex items-baseline gap-3.5">
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Grimoire
        </span>
        <span className="flex-1 border-b border-hairline" />
        <span className="font-mono text-[10px] text-fg-faint">
          {total === 0 ? 'empty' : `${total} entry${total !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Page header */}
      <div className="mb-[22px] flex items-end gap-4">
        <div className="flex-1">
          <h1 className="m-0 font-serif text-[48px] font-normal leading-none tracking-[-1.4px] text-fg">
            The Grimoire.
          </h1>
          <p className="mt-1.5 font-serif text-[16px] italic text-fg-muted">
            slicer profiles &amp; print settings — slicer-side spells for your Loot.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Link
            href="/grimoire/slicer-profiles/new"
            className="rounded-md border border-hairline px-3.5 py-2 font-sans text-[12.5px] text-fg-muted hover:text-fg"
          >
            + New slicer profile
          </Link>
          <Link
            href="/grimoire/print-settings/new"
            className="rounded-md bg-accent px-3.5 py-2 font-sans text-[12.5px] font-semibold text-accent-ink"
          >
            + New print setting
          </Link>
        </div>
      </div>

      {/* Kind filter */}
      <div className="mb-4 flex items-center gap-2">
        {(['all', 'slicer-profile', 'print-setting'] as KindFilter[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKindFilter(k)}
            className={`rounded-md border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[1px] transition-colors ${
              kindFilter === k
                ? 'border-accent-edge bg-accent-soft text-accent'
                : 'border-hairline bg-transparent text-fg-faint hover:text-fg-muted'
            }`}
          >
            {k === 'all' ? 'All' : k === 'slicer-profile' ? 'Slicer profiles' : 'Print settings'}
          </button>
        ))}
      </div>

      {/* List or empty */}
      {rows.length === 0 ? (
        <EmptyHint>
          No Grimoire entries yet. Add a slicer profile or print setting to get started.
        </EmptyHint>
      ) : (
        <>
          <SectionTitle
            meta={`${profiles.length} profile${profiles.length !== 1 ? 's' : ''} · ${settings.length} setting${settings.length !== 1 ? 's' : ''}`}
          >
            All entries
          </SectionTitle>
          <GrimoireTable rows={rows} />
        </>
      )}
    </div>
  );
}
