// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Pre-app form primitives — real interactive controls.
// Ported from planning/design-system/exports/jsx/page-login.jsx
// (Field, PrimaryButton, GhostButton). The mock rendered static spans; these
// are controlled <input>/<button> elements wired to the real backend.

import type { ReactNode } from 'react';
import { forwardRef } from 'react';

/**
 * Label + input + optional hint + error state + optional suffix.
 * The suffix sits inside the input frame (e.g. the password show/hide toggle).
 */
export const Field = forwardRef<
  HTMLInputElement,
  {
    id: string;
    label: string;
    type?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    hint?: ReactNode;
    error?: string;
    mono?: boolean;
    suffix?: ReactNode;
    autoFocus?: boolean;
    autoComplete?: string;
    required?: boolean;
    inputMode?: 'text' | 'url' | 'email';
  }
>(function Field(
  {
    id,
    label,
    type = 'text',
    value,
    onChange,
    placeholder,
    hint,
    error,
    mono = false,
    suffix,
    autoFocus = false,
    autoComplete,
    required = false,
    inputMode,
  },
  ref,
) {
  const errored = !!error;
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className={`font-mono text-[9.5px] uppercase tracking-[1.4px] ${
          errored ? 'text-danger' : 'text-fg-faint'
        }`}
      >
        {label}
      </label>
      <div
        className={`flex items-center gap-2 rounded-md border bg-surface-2 px-[13px] py-[11px] transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-edge ${
          errored ? 'border-danger ring-2 ring-danger/25' : 'border-hairline-strong'
        }`}
      >
        <input
          ref={ref}
          id={id}
          name={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          required={required}
          inputMode={inputMode}
          aria-invalid={errored}
          aria-describedby={
            error ? `${id}-error` : hint ? `${id}-hint` : undefined
          }
          className={`min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg-ghost ${
            mono ? 'font-mono text-[13px] tracking-[0.3px]' : 'font-sans'
          }`}
        />
        {suffix}
      </div>
      {error ? (
        <div id={`${id}-error`} role="alert" className="font-sans text-[11px] leading-[1.4] text-danger">
          {error}
        </div>
      ) : (
        hint && (
          <div id={`${id}-hint`} className="font-sans text-[11px] leading-[1.4] text-fg-faint">
            {hint}
          </div>
        )
      )}
    </div>
  );
});

/** Spinner used by the loading state of PrimaryButton. */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent-ink border-r-transparent"
    />
  );
}

export function PrimaryButton({
  label,
  full = true,
  loading = false,
  disabled = false,
  type = 'submit',
  onClick,
}: {
  label: ReactNode;
  full?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: 'submit' | 'button';
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2.5 rounded-md bg-accent px-[22px] py-3 font-sans text-[13.5px] font-semibold tracking-[0.1px] text-accent-ink shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60 ${
        loading ? 'cursor-wait' : 'cursor-pointer'
      } ${full ? 'w-full' : ''}`}
    >
      {loading && <Spinner />}
      {label}
    </button>
  );
}

export function GhostButton({
  label,
  full = true,
  icon,
  type = 'button',
  onClick,
  disabled = false,
}: {
  label: ReactNode;
  full?: boolean;
  icon?: ReactNode;
  type?: 'submit' | 'button';
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2.5 rounded-md border border-hairline-strong bg-transparent px-[18px] py-[11px] font-sans text-[13px] font-medium text-fg transition-colors hover:border-accent-edge disabled:opacity-60 ${
        full ? 'w-full' : ''
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
