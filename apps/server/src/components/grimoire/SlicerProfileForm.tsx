'use client';
// SlicerProfileForm — create / edit form for slicer profiles.
// Fields: name + slicerKind + printerKind + materialKind + settingsPayload
//         + opaqueUnsupported toggle + notes.
// Canvas reference: GrimoireAttachModal detected block (page-grimoire.jsx line 156–176).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SLICER_KINDS, PRINTER_KINDS, PROFILE_MATERIAL_KINDS } from '@/db/schema.grimoire';
import { slicerKindLabel, printerKindLabel, materialKindLabel } from './grimoire-labels';
import { SettingsJsonField } from './SettingsJsonField';

interface SlicerProfileDto {
  id: string;
  name: string;
  slicerKind: string;
  printerKind: string;
  materialKind: string;
  settingsPayload: Record<string, unknown>;
  opaqueUnsupported: boolean;
  notes: string | null;
}

interface SlicerProfileFormProps {
  /** If supplied, the form operates in edit mode (PATCH). */
  existing?: SlicerProfileDto;
}

type FormFields = {
  name: string;
  slicerKind: string;
  printerKind: string;
  materialKind: string;
  settingsPayload: string;
  opaqueUnsupported: boolean;
  notes: string;
};

const EMPTY: FormFields = {
  name: '',
  slicerKind: 'bambu-studio',
  printerKind: 'fdm',
  materialKind: 'pla',
  settingsPayload: '{}',
  opaqueUnsupported: false,
  notes: '',
};

const inputCls =
  'w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';

const selectCls =
  'w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-sans text-[13px] text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';

function FieldWrap({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint"
      >
        {label}
      </label>
      {children}
      {error && (
        <div
          id={`${htmlFor}-error`}
          role="alert"
          className="mt-1 font-sans text-[11.5px] text-danger"
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function SlicerProfileForm({ existing }: SlicerProfileFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isEdit = !!existing;

  const [form, setForm] = useState<FormFields>(() => {
    if (existing) {
      return {
        name: existing.name,
        slicerKind: existing.slicerKind,
        printerKind: existing.printerKind,
        materialKind: existing.materialKind,
        settingsPayload: JSON.stringify(existing.settingsPayload, null, 2),
        opaqueUnsupported: existing.opaqueUnsupported,
        notes: existing.notes ?? '',
      };
    }
    return EMPTY;
  });

  const [errors, setErrors] = useState<Partial<Record<keyof FormFields, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  function set<K extends keyof FormFields>(k: K, v: FormFields[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  }

  function validate(): boolean {
    const next: Partial<Record<keyof FormFields, string>> = {};
    if (!form.name.trim()) next.name = 'Required.';
    if (!form.slicerKind) next.slicerKind = 'Required.';
    if (!form.printerKind) next.printerKind = 'Required.';
    if (!form.materialKind) next.materialKind = 'Required.';
    if (form.settingsPayload.trim()) {
      try {
        JSON.parse(form.settingsPayload);
      } catch {
        next.settingsPayload = 'Invalid JSON — fix syntax before saving.';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      let payload: Record<string, unknown> = {};
      if (form.settingsPayload.trim()) {
        try {
          payload = JSON.parse(form.settingsPayload) as Record<string, unknown>;
        } catch {
          // validate() already caught this
        }
      }
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        slicerKind: form.slicerKind,
        printerKind: form.printerKind,
        materialKind: form.materialKind,
        settingsPayload: payload,
        opaqueUnsupported: form.opaqueUnsupported,
        ...(form.notes.trim() ? { notes: form.notes.trim() } : { notes: null }),
      };

      const url = isEdit
        ? `/api/v1/grimoire/slicer-profiles/${existing!.id}`
        : '/api/v1/grimoire/slicer-profiles';
      const method = isEdit ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { profile?: { id?: string } };
      return data.profile?.id ?? existing?.id;
    },
    onSuccess: (profileId) => {
      toast.success(isEdit ? 'Slicer profile updated.' : 'Slicer profile created.');
      void queryClient.invalidateQueries({ queryKey: ['slicer-profiles'] });
      if (profileId) {
        router.push(`/grimoire/slicer-profiles/${profileId}`);
      } else {
        router.push('/grimoire');
      }
    },
    onError: (err: Error) => {
      setServerError(err.message);
      toast.error(`Failed to save: ${err.message}`);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    mutate();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-hairline bg-surface p-[22px]"
    >
      {serverError && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-sm border border-danger bg-danger-bg px-3 py-2 font-sans text-[12px] text-danger"
        >
          {serverError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-[18px]">
        {/* Name */}
        <FieldWrap label="Name" htmlFor="sp-name" error={errors.name}>
          <input
            id="sp-name"
            type="text"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="0.16 strong · H2C"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? 'sp-name-error' : undefined}
            className={inputCls}
          />
        </FieldWrap>

        {/* Slicer kind */}
        <FieldWrap label="Slicer" htmlFor="sp-slicer-kind" error={errors.slicerKind}>
          <select
            id="sp-slicer-kind"
            value={form.slicerKind}
            onChange={(e) => set('slicerKind', e.target.value)}
            aria-invalid={!!errors.slicerKind}
            aria-describedby={errors.slicerKind ? 'sp-slicer-kind-error' : undefined}
            className={selectCls}
          >
            {SLICER_KINDS.map((k) => (
              <option key={k} value={k}>{slicerKindLabel(k)}</option>
            ))}
          </select>
        </FieldWrap>

        {/* Printer kind */}
        <FieldWrap label="Printer" htmlFor="sp-printer-kind" error={errors.printerKind}>
          <select
            id="sp-printer-kind"
            value={form.printerKind}
            onChange={(e) => set('printerKind', e.target.value)}
            aria-invalid={!!errors.printerKind}
            aria-describedby={errors.printerKind ? 'sp-printer-kind-error' : undefined}
            className={selectCls}
          >
            {PRINTER_KINDS.map((k) => (
              <option key={k} value={k}>{printerKindLabel(k)}</option>
            ))}
          </select>
        </FieldWrap>

        {/* Material kind */}
        <FieldWrap label="Material target" htmlFor="sp-material-kind" error={errors.materialKind}>
          <select
            id="sp-material-kind"
            value={form.materialKind}
            onChange={(e) => set('materialKind', e.target.value)}
            aria-invalid={!!errors.materialKind}
            aria-describedby={errors.materialKind ? 'sp-material-kind-error' : undefined}
            className={selectCls}
          >
            {PROFILE_MATERIAL_KINDS.map((k) => (
              <option key={k} value={k}>{materialKindLabel(k)}</option>
            ))}
          </select>
        </FieldWrap>
      </div>

      {/* Settings JSON */}
      <div className="mt-[18px]">
        <FieldWrap label="Settings payload (JSON)" htmlFor="sp-payload" error={errors.settingsPayload}>
          <SettingsJsonField
            id="sp-payload"
            value={form.settingsPayload}
            onChange={(v) => set('settingsPayload', v)}
            error={errors.settingsPayload}
            disabled={isPending}
          />
        </FieldWrap>
      </div>

      {/* Opaque unsupported toggle */}
      <div className="mt-[18px] flex items-center gap-3">
        <input
          id="sp-opaque"
          type="checkbox"
          checked={form.opaqueUnsupported}
          onChange={(e) => set('opaqueUnsupported', e.target.checked)}
          className="h-4 w-4 rounded border border-hairline accent-accent"
        />
        <label htmlFor="sp-opaque" className="font-mono text-[10px] uppercase tracking-[1.2px] text-fg-muted">
          Opaque — contains unsupported fields (profile may not be portable)
        </label>
      </div>

      {/* Notes */}
      <div className="mt-[18px]">
        <FieldWrap label="Notes · optional" htmlFor="sp-notes" error={errors.notes}>
          <textarea
            id="sp-notes"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Any extra context about this profile…"
            rows={3}
            aria-invalid={!!errors.notes}
            aria-describedby={errors.notes ? 'sp-notes-error' : undefined}
            className="w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-serif text-[13px] italic text-fg-muted placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
        </FieldWrap>
      </div>

      {/* Actions */}
      <div className="mt-[18px] flex justify-end gap-2.5">
        <button
          type="button"
          onClick={() => router.back()}
          disabled={isPending}
          className="rounded-md border border-hairline px-4 py-2 font-sans text-[12.5px] text-fg-muted hover:text-fg disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create profile'}
        </button>
      </div>
    </form>
  );
}
