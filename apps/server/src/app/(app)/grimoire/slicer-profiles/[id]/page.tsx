// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// /grimoire/slicer-profiles/[id] — slicer profile detail.
// Canvas reference: GrimoireDetail (page-grimoire.jsx line 188–277).

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EmptyHint, KV, MetaBadge, SectionTitle } from '@/components/shell/atoms';
import { GrimoireBadge } from '@/components/grimoire/GrimoireBadge';
import { AttachmentList } from '@/components/grimoire/AttachmentList';
import { SlicerProfileForm } from '@/components/grimoire/SlicerProfileForm';
import { relativeAge } from '@/lib/time';
import { slicerKindLabel, printerKindLabel, materialKindLabel } from '@/components/grimoire/grimoire-labels';

interface SlicerProfileDto {
  id: string;
  ownerId: string;
  name: string;
  slicerKind: string;
  printerKind: string;
  materialKind: string;
  settingsPayload: Record<string, unknown>;
  opaqueUnsupported: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GrimoireAttachmentDto {
  id: string;
  lootId: string;
  note: string | null;
  attachedAt: string;
}

export default function SlicerProfileDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['slicer-profile', id],
    queryFn: async (): Promise<{ profile: SlicerProfileDto }> =>
      (await fetch(`/api/v1/grimoire/slicer-profiles/${id}`)).json(),
    enabled: !!id,
  });

  // NOTE: The API exposes grimoire-attachments only via /loot/[id]/grimoire-attachments.
  // A future API addition would allow querying by profile ID. For now we can't
  // reverse-fetch attachments without iterating all Loot — so the attachment
  // count displayed is a placeholder noting this limitation.
  // This is a backend gap (canvas shows "Used in N prints" but no endpoint exists).

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/grimoire/slicer-profiles/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Slicer profile deleted.');
      void queryClient.invalidateQueries({ queryKey: ['slicer-profiles'] });
      router.push('/grimoire');
    },
    onError: (err: Error) => {
      toast.error(`Failed to delete: ${err.message}`);
    },
  });

  function handleDelete() {
    if (!window.confirm('Delete this slicer profile? This cannot be undone.')) return;
    deleteMutation.mutate();
  }

  if (isError) return <EmptyHint>Failed to load slicer profile.</EmptyHint>;
  if (isLoading) return <EmptyHint>Loading slicer profile…</EmptyHint>;

  const p = data?.profile;
  if (!p) return <EmptyHint>Profile not found.</EmptyHint>;

  const settingsKeys = Object.keys(p.settingsPayload);
  const settingsCount = settingsKeys.length;

  if (editOpen) {
    return (
      <div>
        {/* Breadcrumb */}
        <div className="mb-2 flex items-baseline gap-3.5">
          <Link
            href="/grimoire"
            className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint hover:text-fg-muted"
          >
            Grimoire
          </Link>
          <span className="font-mono text-[10px] text-fg-faint">›</span>
          <button
            type="button"
            onClick={() => setEditOpen(false)}
            className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint hover:text-fg-muted"
          >
            {p.name}
          </button>
          <span className="font-mono text-[10px] text-fg-faint">›</span>
          <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">Edit</span>
          <span className="flex-1 border-b border-hairline" />
        </div>
        <h1 className="m-0 mb-1.5 font-serif text-[44px] font-normal leading-[1.02] tracking-[-1.1px] text-fg">
          Edit profile.
        </h1>
        <p className="mb-[22px] font-serif text-[16px] italic text-fg-muted">
          Changes take effect immediately.
        </p>
        <SlicerProfileForm existing={p} />
      </div>
    );
  }

  return (
    <div>
      {/* Breadcrumb bar */}
      <div className="mb-2.5 flex items-baseline gap-3.5">
        <Link
          href="/grimoire"
          className="font-mono text-[10px] uppercase tracking-[1.4px] text-fg-faint hover:text-fg-muted"
        >
          Grimoire
        </Link>
        <span className="font-mono text-[10px] text-fg-faint">›</span>
        <span className="font-mono text-[10px] uppercase tracking-[1.4px] text-fg-faint">
          {p.id.slice(0, 8)}…
        </span>
        <span className="flex-1 border-b border-dashed border-hairline" />
        <GrimoireBadge kind="slicer-profile" />
        {p.opaqueUnsupported && (
          <MetaBadge tone="running">opaque</MetaBadge>
        )}
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="rounded-sm border border-hairline px-2.5 py-[5px] font-mono text-[9.5px] uppercase tracking-[1px] text-fg-muted hover:text-fg"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
          className="rounded-sm border border-danger px-2.5 py-[5px] font-mono text-[9.5px] uppercase tracking-[1px] text-danger hover:opacity-80 disabled:opacity-50"
        >
          {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {/* Page header */}
      <h1 className="m-0 font-serif text-[44px] font-normal leading-[1.02] tracking-[-1.1px] text-fg">
        {p.name}.
      </h1>
      <p className="mt-1.5 mb-[22px] font-serif text-[16px] italic text-fg-muted">
        {slicerKindLabel(p.slicerKind)}
        {' · '}
        {printerKindLabel(p.printerKind)}
        {' · '}
        {materialKindLabel(p.materialKind)}
      </p>

      {/* Two-column layout */}
      <div className="grid gap-[22px]" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        {/* Left — settings payload diff */}
        <div>
          <SectionTitle meta={`${settingsCount} key${settingsCount !== 1 ? 's' : ''}`}>
            Settings payload
          </SectionTitle>
          {settingsCount === 0 ? (
            <EmptyHint>No settings stored — empty payload.</EmptyHint>
          ) : (
            <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
              <div
                className="grid items-center gap-2.5 border-b border-hairline bg-surface-2 px-[14px] py-[10px] font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint"
                style={{ gridTemplateColumns: '1.6fr 1fr' }}
              >
                <span>Key</span>
                <span>Value</span>
              </div>
              {settingsKeys.map((k, idx) => {
                const v = p.settingsPayload[k];
                const isLast = idx === settingsKeys.length - 1;
                return (
                  <div
                    key={k}
                    className={`grid items-baseline gap-2.5 px-[14px] py-[8px] font-mono text-[11.5px] ${
                      isLast ? '' : 'border-b border-dashed border-hairline'
                    }`}
                    style={{ gridTemplateColumns: '1.6fr 1fr' }}
                  >
                    <span className="text-fg">{k}</span>
                    <span className="text-accent">{JSON.stringify(v)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Notes */}
          {p.notes && (
            <div className="mt-[18px]">
              <SectionTitle as="h3">Notes</SectionTitle>
              <div className="rounded-md border border-hairline bg-surface p-4 font-serif text-[14px] italic text-fg-muted">
                {p.notes}
              </div>
            </div>
          )}

          {/* Attachments */}
          <div className="mt-[18px]">
            <SectionTitle as="h3" meta="loot items using this profile">
              Attachments
            </SectionTitle>
            <EmptyHint>
              Attachment reverse-lookup not available yet — attach this profile from a Loot detail page.
            </EmptyHint>
          </div>
        </div>

        {/* Right — provenance */}
        <aside className="flex flex-col gap-[18px]">
          <div className="rounded-lg border border-hairline bg-surface p-4">
            <div className="mb-2 font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
              Provenance
            </div>
            <dl>
              <KV k="id" v={p.id} mono />
              <KV k="slicer" v={slicerKindLabel(p.slicerKind)} />
              <KV k="printer" v={printerKindLabel(p.printerKind)} />
              <KV k="material" v={materialKindLabel(p.materialKind)} />
              <KV k="created" v={relativeAge(new Date(p.createdAt))} />
              <KV k="updated" v={relativeAge(new Date(p.updatedAt))} />
              {p.opaqueUnsupported && (
                <KV k="portable" v="no — contains unsupported fields" />
              )}
            </dl>
          </div>

          {/* Stat tile */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-hairline bg-surface p-3">
              <div className="font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint">Keys</div>
              <div className="mt-0.5 font-serif text-[22px] tracking-[-0.4px] text-fg">{settingsCount}</div>
              <div className="mt-1 font-mono text-[9.5px] text-fg-faint">payload entries</div>
            </div>
            <div className="rounded-md border border-hairline bg-surface p-3">
              <div className="font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint">Age</div>
              <div className="mt-0.5 font-serif text-[22px] tracking-[-0.4px] text-fg">
                {relativeAge(new Date(p.createdAt))}
              </div>
              <div className="mt-1 font-mono text-[9.5px] text-fg-faint">since created</div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
