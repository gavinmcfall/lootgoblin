'use client';
// MaterialField — labelled field row used in create form and detail page.
// Matches canvas Field component (page-materials.jsx line 417).
// For form inputs, wrap children; for display, pass value prop.

import type { ReactNode } from 'react';

interface MaterialFieldProps {
  label: string;
  /** Static display value (string). When provided, renders a read-only cell. */
  value?: string;
  /** Alternative to value — any node (e.g. an input, select, or swatch+input combo). */
  children?: ReactNode;
  mono?: boolean;
  italic?: boolean;
  /** Hex color swatch to show before the value. */
  swatch?: string | null;
  /** Hint text below the field. */
  hint?: string;
}

export function MaterialField({
  label,
  value,
  children,
  mono = false,
  italic = false,
  swatch,
  hint,
}: MaterialFieldProps) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint">
        {label}
      </div>
      <div className="flex items-center gap-2.5 rounded-sm border border-hairline bg-bg px-[10px] py-2">
        {swatch && (
          <span
            className="h-3.5 w-3.5 shrink-0 rounded-[3px] border border-hairline"
            style={{ background: swatch }}
          />
        )}
        {children ?? (
          <span
            className={`flex-1 text-[13px] text-fg ${mono ? 'font-mono' : italic ? 'font-serif italic' : 'font-sans'}`}
          >
            {value ?? ''}
          </span>
        )}
      </div>
      {hint && (
        <div className="mt-1 font-mono text-[9.5px] text-fg-faint">· {hint}</div>
      )}
    </div>
  );
}
