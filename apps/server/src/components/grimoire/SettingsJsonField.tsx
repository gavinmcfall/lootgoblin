'use client';
// SettingsJsonField — controlled textarea for JSON payloads.
// Pretty-prints on valid parse; shows aria-invalid + error on bad JSON.
// Canvas reference: implied by GrimoireDetail settingsPayload display.

import { useId, useState } from 'react';

interface SettingsJsonFieldProps {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  disabled?: boolean;
}

const textareaCls =
  'w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-mono text-[12px] text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 aria-[invalid=true]:border-danger';

export function SettingsJsonField({
  id,
  value,
  onChange,
  error,
  disabled,
}: SettingsJsonFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const [localError, setLocalError] = useState<string | null>(null);

  const effectiveError = error ?? localError ?? null;

  function handleBlur() {
    if (!value.trim()) {
      setLocalError(null);
      return;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      const pretty = JSON.stringify(parsed, null, 2);
      onChange(pretty);
      setLocalError(null);
    } catch {
      setLocalError('Invalid JSON — check syntax before saving.');
    }
  }

  return (
    <div>
      <textarea
        id={fieldId}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (localError) setLocalError(null);
        }}
        onBlur={handleBlur}
        disabled={disabled}
        rows={10}
        placeholder={'{\n  "key": "value"\n}'}
        aria-invalid={!!effectiveError}
        aria-describedby={effectiveError ? errorId : undefined}
        className={textareaCls}
      />
      {effectiveError && (
        <div
          id={errorId}
          role="alert"
          className="mt-1 font-sans text-[11.5px] text-danger"
        >
          {effectiveError}
        </div>
      )}
    </div>
  );
}
