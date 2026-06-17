// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// MaterialAddForm — manual create form with catalog autocomplete.
// Canvas reference: MatAddFlow "Step 2 · fill the line" (page-materials.jsx line 391-412).
// Catalog autocomplete (filaments + resins) auto-populates fields; manual
// override is always allowed. Barcode + receipt paths (B + C) are deferred.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EmptyHint } from '@/components/shell/atoms';

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
  density: string;
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
  density: '',
};

// Shape of catalog hits — the subset we consume. Filament hits expose
// `density`; resin hits expose `densityGMl`. We accept both at runtime.
interface CatalogHit {
  id: string;
  brand: string;
  subtype: string;
  colors: string[] | null;
  colorName: string | null;
  density?: number | null;
  densityGMl?: number | null;
  colorPattern?: string;
}

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

// Debounce a string value. 300ms matches the spec.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function MaterialAddForm() {
  const router = useRouter();
  const [form, setForm] = useState<FormFields>(EMPTY);
  const [productId, setProductId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof FormFields, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  // Catalog search state.
  const [searchTerm, setSearchTerm] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const listboxRef = useRef<HTMLUListElement>(null);
  const debouncedSearch = useDebounced(searchTerm, 300);

  // Catalog applies to filaments + resins only.
  const catalogEndpoint = useMemo<'filaments' | 'resins' | null>(() => {
    if (form.kind === 'filament_spool') return 'filaments';
    if (form.kind === 'resin_bottle') return 'resins';
    return null;
  }, [form.kind]);

  const catalogQ = useQuery({
    queryKey: ['catalog-search', catalogEndpoint, debouncedSearch],
    queryFn: async (): Promise<{ products: CatalogHit[] }> => {
      const res = await fetch(
        `/api/v1/catalog/${catalogEndpoint}/search?q=${encodeURIComponent(debouncedSearch)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      // Filament endpoint returns { filaments } or { products }; resin returns
      // { resins } or { products }. Normalise to a single list.
      const list =
        (body as { filaments?: CatalogHit[] }).filaments ??
        (body as { resins?: CatalogHit[] }).resins ??
        (body as { products?: CatalogHit[] }).products ??
        [];
      return { products: list };
    },
    enabled: !!catalogEndpoint && debouncedSearch.length >= 2,
  });

  function set<K extends keyof FormFields>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
    // Mutating any populated field clears the catalog binding — user is
    // overriding, productId should no longer track that catalog row.
    if (
      productId &&
      (k === 'brand' || k === 'subtype' || k === 'colorName' || k === 'color1' || k === 'colorPattern')
    ) {
      setProductId(null);
    }
  }

  function applyCatalogHit(hit: CatalogHit) {
    const density = hit.density ?? hit.densityGMl ?? null;
    setForm((f) => ({
      ...f,
      brand: hit.brand ?? f.brand,
      subtype: hit.subtype ?? f.subtype,
      colorName: hit.colorName ?? f.colorName,
      color1: hit.colors && hit.colors[0] ? hit.colors[0] : f.color1,
      colorPattern: hit.colorPattern ?? f.colorPattern,
      density: density != null ? String(density) : f.density,
    }));
    setProductId(hit.id);
    setSearchTerm('');
    setDropdownOpen(false);
    setErrors({});
  }

  function skipCatalog() {
    setProductId(null);
    setSearchTerm('');
    setDropdownOpen(false);
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
    if (form.density && (isNaN(parseFloat(form.density)) || parseFloat(form.density) <= 0))
      next.density = 'Must be a positive number, or leave empty.';
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
        ...(form.density ? { density: parseFloat(form.density) } : {}),
        ...(productId ? { productId } : {}),
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
        setProductId(null);
        setSearchTerm('');
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

  const hits = catalogQ.data?.products ?? [];
  const showDropdown =
    !!catalogEndpoint &&
    dropdownOpen &&
    (catalogQ.isLoading || catalogQ.isError || hits.length > 0 || debouncedSearch.length >= 2);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit(false);
      }}
      className="rounded-lg border border-hairline bg-surface p-[22px]"
    >
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

      {/* Catalog autocomplete — filaments + resins only */}
      {catalogEndpoint && (
        <div className="relative mb-[18px]">
          <label
            htmlFor="catalog-search"
            className="mb-1.5 block font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint"
          >
            Catalog search
          </label>
          <input
            id="catalog-search"
            type="text"
            role="combobox"
            aria-controls="catalog-listbox"
            aria-expanded={showDropdown}
            aria-autocomplete="list"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setDropdownOpen(true);
            }}
            onFocus={() => setDropdownOpen(true)}
            placeholder={
              catalogEndpoint === 'filaments'
                ? 'Search catalog (e.g. Bambu PLA Basic Black)…'
                : 'Search catalog (e.g. Siraya Tech Tenacious)…'
            }
            className={inputCls}
          />
          <button
            type="button"
            onClick={skipCatalog}
            className="mt-1 font-mono text-[10px] uppercase tracking-[1px] text-fg-faint hover:text-fg-muted"
          >
            Skip catalog · enter manually
          </button>

          {/* Dropdown */}
          {showDropdown && (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-hairline bg-surface shadow-lg">
              {catalogQ.isError && (
                <div className="p-2">
                  <EmptyHint>Catalog search failed.</EmptyHint>
                </div>
              )}
              {!catalogQ.isError && catalogQ.isLoading && (
                <div className="p-2">
                  <EmptyHint>Searching catalog…</EmptyHint>
                </div>
              )}
              {!catalogQ.isError && !catalogQ.isLoading && hits.length === 0 && (
                <div className="p-2">
                  <EmptyHint>No catalog hits — enter manually below.</EmptyHint>
                </div>
              )}
              {!catalogQ.isError && !catalogQ.isLoading && hits.length > 0 && (
                <ul
                  id="catalog-listbox"
                  ref={listboxRef}
                  role="listbox"
                  className="max-h-[260px] overflow-y-auto"
                >
                  {hits.map((hit) => (
                    <li
                      key={hit.id}
                      role="option"
                      aria-selected={productId === hit.id}
                      onClick={() => applyCatalogHit(hit)}
                      className="flex cursor-pointer items-center gap-2.5 border-b border-dashed border-hairline px-3 py-2 last:border-b-0 hover:bg-surface-2"
                    >
                      <span className="flex shrink-0 gap-0.5">
                        {(hit.colors ?? ['#888888']).slice(0, 4).map((c, i) => (
                          <span
                            key={`${hit.id}-${i}`}
                            className="h-4 w-4 rounded-[3px] border border-hairline"
                            style={{ background: c }}
                          />
                        ))}
                      </span>
                      <span className="flex-1 text-[12.5px] text-fg">
                        <span className="font-sans font-medium">{hit.brand}</span>
                        <span className="ml-1.5 font-mono text-[10.5px] text-fg-faint">
                          · {hit.subtype}
                        </span>
                        {hit.colorName && (
                          <span className="ml-1.5 font-serif text-[11.5px] italic text-fg-muted">
                            {hit.colorName}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {productId && (
            <div className="mt-2 font-mono text-[10px] text-accent">
              · Linked to catalog product {productId.slice(0, 8)}…
            </div>
          )}
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

        {/* Density (optional) */}
        <FieldWrap label="Density (g/cm³) · optional" htmlFor="mat-density" error={errors.density}>
          <input
            id="mat-density"
            type="number"
            min={0}
            step="any"
            value={form.density}
            onChange={(e) => set('density', e.target.value)}
            placeholder="1.24"
            aria-invalid={!!errors.density}
            aria-describedby={errors.density ? 'mat-density-error' : undefined}
            className={inputCls}
          />
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
          type="submit"
          disabled={isPending}
          className="rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? 'Adding…' : 'Add to workshop'}
        </button>
      </div>
    </form>
  );
}
