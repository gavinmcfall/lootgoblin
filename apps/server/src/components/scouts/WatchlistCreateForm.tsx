// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// WatchlistCreateForm — create a new watchlist subscription.
// Canvas variant: SubscriptionCreate (page-subscriptions.jsx line 69-122).
//
// Deviations from canvas:
//   1. Dry-fire preview block OMITTED — no /dry-fire endpoint exists yet.
//      TODO: add dry-fire preview once the endpoint is implemented.
//   2. Kind is selected explicitly (not inferred from URL) — URL inference
//      requires a dry-fire backend call.
//   3. Source adapter and collection are dropdowns from existing API data.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Tile, EmptyHint } from '@/components/shell/atoms';

interface SourceCapabilities {
  id: string;
  displayName: string;
}

interface Collection {
  id: string;
  name: string;
}

type WatchKind = 'creator' | 'tag' | 'saved_search' | 'url_watch' | 'folder_watch';

const KIND_OPTIONS: { value: WatchKind; label: string }[] = [
  { value: 'creator', label: 'Creator' },
  { value: 'tag', label: 'Tag' },
  { value: 'saved_search', label: 'Saved Search' },
  { value: 'url_watch', label: 'URL Watch' },
  { value: 'folder_watch', label: 'Folder Watch' },
];

const CADENCE_OPTIONS = [
  { value: 3600, label: 'Hourly' },
  { value: 86400, label: 'Daily' },
  { value: 86400 * 7, label: 'Weekly' },
];

const INPUT_CLASS =
  'w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 font-mono text-[12.5px] text-fg placeholder:text-fg-ghost focus:outline-none focus:ring-2 focus:ring-accent-edge focus:border-accent';
const SELECT_CLASS =
  'w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 font-mono text-[12.5px] text-fg focus:outline-none focus:ring-2 focus:ring-accent-edge focus:border-accent';
const LABEL_CLASS = 'block font-mono text-[10px] uppercase tracking-[1px] text-fg-faint mb-1';

export function WatchlistCreateForm() {
  const router = useRouter();
  const qc = useQueryClient();

  const [kind, setKind] = useState<WatchKind>('creator');
  const [paramValue, setParamValue] = useState('');
  const [sourceAdapterId, setSourceAdapterId] = useState('');
  const [cadenceSeconds, setCadenceSeconds] = useState(3600);
  const [defaultCollectionId, setDefaultCollectionId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | undefined>(undefined);

  // Field-level errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  const {
    data: sourcesData,
    isError: sourcesError,
    isLoading: sourcesLoading,
  } = useQuery({
    queryKey: ['sources'],
    queryFn: async (): Promise<{ sources: SourceCapabilities[] }> =>
      (await fetch('/api/v1/scouts')).json(),
  });

  const {
    data: collectionsData,
    isError: collectionsError,
    isLoading: collectionsLoading,
  } = useQuery({
    queryKey: ['collections'],
    queryFn: async (): Promise<{ collections: Collection[] }> =>
      (await fetch('/api/v1/collections')).json(),
  });

  if (sourcesError) return <EmptyHint>Failed to load scout adapters.</EmptyHint>;
  if (collectionsError) return <EmptyHint>Failed to load collections.</EmptyHint>;

  const sources = sourcesData?.sources ?? [];
  const collections = collectionsData?.collections ?? [];

  function validate() {
    const errs: Record<string, string> = {};
    if (!paramValue.trim()) errs.paramValue = 'Value is required';
    if (!sourceAdapterId) errs.sourceAdapterId = 'Source adapter is required';
    if (!defaultCollectionId) errs.defaultCollectionId = 'Collection is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function buildParameters(): object {
    const v = paramValue.trim();
    switch (kind) {
      case 'creator': return { kind: 'creator', creatorId: v };
      case 'tag': return { kind: 'tag', tag: v };
      case 'saved_search': return { kind: 'saved_search', query: v };
      case 'url_watch': return { kind: 'url_watch', url: v };
      case 'folder_watch': return { kind: 'folder_watch', folderId: v };
    }
  }

  function paramLabel(): string {
    switch (kind) {
      case 'creator': return 'Creator ID';
      case 'tag': return 'Tag';
      case 'saved_search': return 'Search query';
      case 'url_watch': return 'URL';
      case 'folder_watch': return 'Folder ID';
    }
  }

  function paramPlaceholder(): string {
    switch (kind) {
      case 'creator': return 'e.g. brennenwalker';
      case 'tag': return 'e.g. mk-vi';
      case 'saved_search': return 'e.g. warhammer mk6';
      case 'url_watch': return 'https://example.com/page';
      case 'folder_watch': return 'folder-id or path';
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setServerError(undefined);
    try {
      const res = await fetch('/api/v1/watchlist/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          source_adapter_id: sourceAdapterId,
          parameters: buildParameters(),
          cadence_seconds: cadenceSeconds,
          default_collection_id: defaultCollectionId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string; reason?: string };
        setServerError(body.reason ?? body.error ?? 'Failed to create watch');
        toast.error('Failed to create watch');
        return;
      }
      const { subscription } = (await res.json()) as { subscription: { id: string } };
      toast.success('Watch created');
      await qc.invalidateQueries({ queryKey: ['watchlist-subscriptions'] });
      router.push(`/scouts/watchlist/${subscription.id}`);
    } catch {
      setServerError('Network error — please try again');
      toast.error('Network error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Tile className="max-w-2xl p-7">
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {/* Kind */}
        <div>
          <label htmlFor="field-kind" className={LABEL_CLASS}>Watch kind</label>
          <select
            id="field-kind"
            value={kind}
            onChange={(e) => { setKind(e.target.value as WatchKind); setParamValue(''); }}
            className={SELECT_CLASS}
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Parameter value (kind-specific) */}
        <div>
          <label htmlFor="field-param-value" className={LABEL_CLASS}>{paramLabel()}</label>
          <input
            id="field-param-value"
            type="text"
            value={paramValue}
            onChange={(e) => setParamValue(e.target.value)}
            placeholder={paramPlaceholder()}
            aria-invalid={errors.paramValue ? true : undefined}
            aria-describedby={errors.paramValue ? 'err-param-value' : undefined}
            className={INPUT_CLASS}
          />
          {errors.paramValue && (
            <p id="err-param-value" role="alert" className="mt-1 text-[11px] text-danger">
              {errors.paramValue}
            </p>
          )}
        </div>

        {/* Source adapter */}
        <div>
          <label htmlFor="field-source-adapter" className={LABEL_CLASS}>Source adapter</label>
          {sourcesLoading && (
            <div className="mb-1">
              <EmptyHint>Loading sources…</EmptyHint>
            </div>
          )}
          <select
            id="field-source-adapter"
            value={sourceAdapterId}
            onChange={(e) => setSourceAdapterId(e.target.value)}
            disabled={sourcesLoading}
            aria-invalid={errors.sourceAdapterId ? true : undefined}
            aria-describedby={errors.sourceAdapterId ? 'err-source-adapter' : undefined}
            className={SELECT_CLASS}
          >
            <option value="">Select a scout adapter…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.displayName}</option>
            ))}
          </select>
          {errors.sourceAdapterId && (
            <p id="err-source-adapter" role="alert" className="mt-1 text-[11px] text-danger">
              {errors.sourceAdapterId}
            </p>
          )}
        </div>

        {/* Cadence */}
        <div>
          <label htmlFor="field-cadence" className={LABEL_CLASS}>Cadence</label>
          <select
            id="field-cadence"
            value={cadenceSeconds}
            onChange={(e) => setCadenceSeconds(Number(e.target.value))}
            className={SELECT_CLASS}
          >
            {CADENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Default collection */}
        <div>
          <label htmlFor="field-collection" className={LABEL_CLASS}>Land in collection</label>
          {collectionsLoading && (
            <div className="mb-1">
              <EmptyHint>Loading libraries…</EmptyHint>
            </div>
          )}
          <select
            id="field-collection"
            value={defaultCollectionId}
            onChange={(e) => setDefaultCollectionId(e.target.value)}
            disabled={collectionsLoading}
            aria-invalid={errors.defaultCollectionId ? true : undefined}
            aria-describedby={errors.defaultCollectionId ? 'err-collection' : undefined}
            className={SELECT_CLASS}
          >
            <option value="">Select a collection…</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {errors.defaultCollectionId && (
            <p id="err-collection" role="alert" className="mt-1 text-[11px] text-danger">
              {errors.defaultCollectionId}
            </p>
          )}
        </div>

        {/* Server error */}
        {serverError && (
          <p role="alert" className="rounded-md border border-danger bg-danger-bg px-3 py-2 text-[12px] text-danger">
            {serverError}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => router.back()}
            className="px-3.5 py-2 font-mono text-[12px] text-fg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-accent px-4 py-2 font-mono text-[12.5px] font-semibold text-accent-ink disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save watch'}
          </button>
        </div>
      </form>
    </Tile>
  );
}
