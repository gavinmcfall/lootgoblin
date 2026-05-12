'use client';
// MaterialAddForm — manual create form for a material.
// Canvas reference: MatAddFlow "Step 2 · fill the line" (page-materials.jsx line 391-412).
// Barcode + receipt paths (B + C) are canvas-only; this ships the manual (A) path.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

const KIND_OPTIONS = [
  { value: 'filament_spool', label: 'Filament spool' },
  { value: 'resin_bottle',   label: 'Resin bottle' },
  { value: 'mix_batch',      label: 'Mix batch' },
  { value: 'recycled_spool', label: 'Recycled spool' },
  { value: 'other',          label: 'Other' },
] as const;

const UNIT_OPTIONS = [
  { value: 'g',  label: 'Grams (g)' },
  { value: 'ml', label: 'Millilitres (ml)' },
] as const;

const COLOR_PATTERN_OPTIONS = [
  { value: 'solid',         label: 'Solid' },
  { value: 'dual-tone',     label: 'Dual-tone' },
  { value: 'gradient',      label: 'Gradient' },
  { value: 'multi-section', label: 'Multi-section' },
] as const;

type FormFields = {
  kind: string;
  brand: string;
  subtype: string;
  colorName: string;
  color1: string;
  colorPattern: string;
  initialAmount: string;
  unit: string;
};

const EMPTY: FormFields = {
  kind: 'filament_spool',
  brand: '',
  subtype: '',
  colorName: '',
  color1: '#888888',
  colorPattern: 'solid',
  initialAmount: '1000',
  unit: 'g',
};

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

const inputCls =
  'w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';

const selectCls =
  'w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-sans text-[13px] text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';

export function MaterialAddForm() {
  const router = useRouter();
  const [form, setForm] = useState<FormFields>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof FormFields, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  function set<K extends keyof FormFields>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  }

  function validate(): boolean {
    const next: Partial<Record<keyof FormFields, string>> = {};
    if (!form.kind) next.kind = 'Required.';
    const amt = parseFloat(form.initialAmount);
    if (!form.initialAmount || isNaN(amt) || amt <= 0)
      next.initialAmount = 'Must be a positive number.';
    if (!form.unit) next.unit = 'Required.';
    const hexRe = /^#[0-9A-Fa-f]{6}$/;
    if (form.color1 && !hexRe.test(form.color1))
      next.color1 = 'Must be a 6-digit hex, e.g. #FF0000.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  const { mutate, isPending } = useMutation({
    mutationFn: async (saveAndNew: boolean) => {
      const hexRe = /^#[0-9A-Fa-f]{6}$/;
      const body: Record<string, unknown> = {
        kind: form.kind,
        initialAmount: parseFloat(form.initialAmount),
        unit: form.unit,
        ...(form.brand.trim() ? { brand: form.brand.trim() } : {}),
        ...(form.subtype.trim() ? { subtype: form.subtype.trim() } : {}),
        ...(form.colorName.trim() ? { colorName: form.colorName.trim() } : {}),
        ...(hexRe.test(form.color1)
          ? { colors: [form.color1.toUpperCase()], colorPattern: form.colorPattern }
          : {}),
      };
      const res = await fetch('/api/v1/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { material?: { id?: string } };
      return { id: data.material?.id, saveAndNew };
    },
    onSuccess: ({ id, saveAndNew }) => {
      toast.success('Material added to workshop.');
      if (saveAndNew) {
        setForm(EMPTY);
        setServerError(null);
        setErrors({});
      } else {
        router.push(id ? `/materials/${id}` : '/materials');
      }
    },
    onError: (err: Error) => {
      setServerError(err.message);
      toast.error(`Failed to add material: ${err.message}`);
    },
  });

  function handleSubmit(saveAndNew: boolean) {
    if (!validate()) return;
    mutate(saveAndNew);
  }

  return (
    <div className="rounded-lg border border-hairline bg-surface p-[22px]">
      {/* Server error */}
      {serverError && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-sm border border-danger bg-danger-bg px-3 py-2 font-sans text-[12px] text-danger"
        >
          {serverError}
        </div>
      )}

      <div className="grid grid-cols-3 gap-[18px]">
        {/* Kind */}
        <FieldWrap label="Kind" htmlFor="mat-kind" error={errors.kind}>
          <select
            id="mat-kind"
            value={form.kind}
            onChange={(e) => set('kind', e.target.value)}
            aria-invalid={!!errors.kind}
            aria-describedby={errors.kind ? 'mat-kind-error' : undefined}
            className={selectCls}
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldWrap>

        {/* Brand */}
        <FieldWrap label="Brand" htmlFor="mat-brand" error={errors.brand}>
          <input
            id="mat-brand"
            type="text"
            value={form.brand}
            onChange={(e) => set('brand', e.target.value)}
            placeholder="Polymaker · Bambu · Siraya…"
            aria-invalid={!!errors.brand}
            aria-describedby={errors.brand ? 'mat-brand-error' : undefined}
            className={inputCls}
          />
        </FieldWrap>

        {/* Subtype / material line */}
        <FieldWrap label="Subtype / line" htmlFor="mat-subtype" error={errors.subtype}>
          <input
            id="mat-subtype"
            type="text"
            value={form.subtype}
            onChange={(e) => set('subtype', e.target.value)}
            placeholder="PLA · PETG · ABS · Blu…"
            aria-invalid={!!errors.subtype}
            aria-describedby={errors.subtype ? 'mat-subtype-error' : undefined}
            className={inputCls}
          />
        </FieldWrap>

        {/* Color name */}
        <FieldWrap label="Color name" htmlFor="mat-color-name" error={errors.colorName}>
          <input
            id="mat-color-name"
            type="text"
            value={form.colorName}
            onChange={(e) => set('colorName', e.target.value)}
            placeholder="Ebony Black · Galaxy Rust…"
            aria-invalid={!!errors.colorName}
            aria-describedby={errors.colorName ? 'mat-color-name-error' : undefined}
            className={inputCls}
          />
        </FieldWrap>

        {/* Hex color */}
        <FieldWrap label="Color · hex" htmlFor="mat-color1" error={errors.color1}>
          <div className="flex items-center gap-2">
            <span
              className="h-6 w-6 shrink-0 rounded-[3px] border border-hairline"
              style={{ background: /^#[0-9A-Fa-f]{6}$/.test(form.color1) ? form.color1 : '#888' }}
            />
            <input
              id="mat-color1"
              type="text"
              value={form.color1}
              onChange={(e) => set('color1', e.target.value)}
              placeholder="#1A1A1A"
              aria-invalid={!!errors.color1}
              aria-describedby={errors.color1 ? 'mat-color1-error' : undefined}
              className={`${inputCls} flex-1`}
            />
          </div>
        </FieldWrap>

        {/* Color pattern */}
        <FieldWrap label="Color pattern" htmlFor="mat-color-pattern" error={errors.colorPattern}>
          <select
            id="mat-color-pattern"
            value={form.colorPattern}
            onChange={(e) => set('colorPattern', e.target.value)}
            aria-invalid={!!errors.colorPattern}
            aria-describedby={errors.colorPattern ? 'mat-color-pattern-error' : undefined}
            className={selectCls}
          >
            {COLOR_PATTERN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldWrap>

        {/* Initial amount */}
        <FieldWrap label="Amount" htmlFor="mat-amount" error={errors.initialAmount}>
          <input
            id="mat-amount"
            type="number"
            min={0}
            step="any"
            value={form.initialAmount}
            onChange={(e) => set('initialAmount', e.target.value)}
            aria-invalid={!!errors.initialAmount}
            aria-describedby={errors.initialAmount ? 'mat-amount-error' : undefined}
            className={inputCls}
          />
        </FieldWrap>

        {/* Unit */}
        <FieldWrap label="Unit" htmlFor="mat-unit" error={errors.unit}>
          <select
            id="mat-unit"
            value={form.unit}
            onChange={(e) => set('unit', e.target.value)}
            aria-invalid={!!errors.unit}
            aria-describedby={errors.unit ? 'mat-unit-error' : undefined}
            className={selectCls}
          >
            {UNIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldWrap>
      </div>

      {/* Actions */}
      <div className="mt-[18px] flex justify-end gap-2.5">
        <button
          type="button"
          onClick={() => handleSubmit(true)}
          disabled={isPending}
          className="rounded-md border border-hairline px-4 py-2 font-sans text-[12.5px] text-fg-muted hover:text-fg disabled:opacity-50"
        >
          Save and add another
        </button>
        <button
          type="button"
          onClick={() => handleSubmit(false)}
          disabled={isPending}
          className="rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? 'Adding…' : 'Add to workshop'}
        </button>
      </div>
    </div>
  );
}
