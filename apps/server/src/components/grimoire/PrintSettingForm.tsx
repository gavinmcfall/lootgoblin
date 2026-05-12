'use client';
// PrintSettingForm — create / edit form for print settings.
// Fields: name + settingsPayload (JSON) + notes.
// Canvas reference: implied by GrimoireDetail (page-grimoire.jsx line 188–277).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SettingsJsonField } from './SettingsJsonField';

interface PrintSettingDto {
  id: string;
  name: string;
  settingsPayload: Record<string, unknown>;
  notes: string | null;
}

interface PrintSettingFormProps {
  /** If supplied, the form operates in edit mode (PATCH). */
  existing?: PrintSettingDto;
}

type FormFields = {
  name: string;
  settingsPayload: string;
  notes: string;
};

const EMPTY: FormFields = {
  name: '',
  settingsPayload: '{}',
  notes: '',
};

const inputCls =
  'w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';

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

export function PrintSettingForm({ existing }: PrintSettingFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isEdit = !!existing;

  const [form, setForm] = useState<FormFields>(() => {
    if (existing) {
      return {
        name: existing.name,
        settingsPayload: JSON.stringify(existing.settingsPayload, null, 2),
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
        settingsPayload: payload,
        ...(form.notes.trim() ? { notes: form.notes.trim() } : { notes: null }),
      };

      const url = isEdit
        ? `/api/v1/grimoire/print-settings/${existing!.id}`
        : '/api/v1/grimoire/print-settings';
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
      const data = (await res.json()) as { setting?: { id?: string } };
      return data.setting?.id ?? existing?.id;
    },
    onSuccess: (settingId) => {
      toast.success(isEdit ? 'Print setting updated.' : 'Print setting created.');
      void queryClient.invalidateQueries({ queryKey: ['print-settings'] });
      if (settingId) {
        router.push(`/grimoire/print-settings/${settingId}`);
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

      {/* Name */}
      <FieldWrap label="Name" htmlFor="ps-name" error={errors.name}>
        <input
          id="ps-name"
          type="text"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Armour panel · fine detail"
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'ps-name-error' : undefined}
          className={inputCls}
        />
      </FieldWrap>

      {/* Settings JSON */}
      <div className="mt-[18px]">
        <FieldWrap label="Settings payload (JSON)" htmlFor="ps-payload" error={errors.settingsPayload}>
          <SettingsJsonField
            id="ps-payload"
            value={form.settingsPayload}
            onChange={(v) => set('settingsPayload', v)}
            error={errors.settingsPayload}
            disabled={isPending}
          />
        </FieldWrap>
      </div>

      {/* Notes */}
      <div className="mt-[18px]">
        <FieldWrap label="Notes · optional" htmlFor="ps-notes" error={errors.notes}>
          <textarea
            id="ps-notes"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Any extra context about this print setting…"
            rows={3}
            aria-invalid={!!errors.notes}
            aria-describedby={errors.notes ? 'ps-notes-error' : undefined}
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
          {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create setting'}
        </button>
      </div>
    </form>
  );
}
