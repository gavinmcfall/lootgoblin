'use client';
// RetireDialog — modal for retiring a material.
// Canvas reference: RetireDialog (page-materials.jsx line 524-592).
// Full a11y: role=dialog, aria-modal, aria-labelledby, Escape handler,
// focus capture + restore. Plain <div> overlay — NOT Tile (Plan I T8 lesson).

import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

const RETIRE_REASONS = [
  { k: 'CONTAMINATED', body: 'Got dust, glitter, or strands of another color baked in.' },
  { k: 'EXPIRED', body: 'Past usable life — hydrolysed, brittle, or chalky.' },
  { k: 'SPILLED', body: 'Bottle knocked, tray spilled — material gone, not waste.' },
  { k: 'DAMAGED', body: 'Spool cracked, tangled, or no longer feeds clean.' },
  { k: 'OTHER', body: 'Tell us why in the note below.' },
] as const;

interface RetireDialogProps {
  materialId: string;
  materialName: string;
  onClose: () => void;
}

export function RetireDialog({ materialId, materialName, onClose }: RetireDialogProps) {
  const titleId = useId();
  const firstInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  const [selectedReason, setSelectedReason] = useState<string>('OTHER');
  const [note, setNote] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  // Capture previously focused element + restore on close.
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    firstInputRef.current?.focus();
    return () => {
      if (
        previousFocusRef.current instanceof HTMLElement ||
        previousFocusRef.current instanceof SVGElement
      ) {
        previousFocusRef.current.focus();
      }
    };
  }, []);

  // Escape key closes without retiring.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      const reason = selectedReason === 'OTHER' && note.trim()
        ? note.trim()
        : `${selectedReason}${note.trim() ? `: ${note.trim()}` : ''}`;
      const res = await fetch(`/api/v1/materials/${materialId}/retire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Material retired.');
      void queryClient.invalidateQueries({ queryKey: ['materials'] });
      void queryClient.invalidateQueries({ queryKey: ['material', materialId] });
      onClose();
    },
    onError: (err: Error) => {
      setServerError(err.message);
      toast.error(`Failed to retire: ${err.message}`);
    },
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-6"
    >
      <div className="w-full max-w-[620px] overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg">
        {/* Header */}
        <div className="px-[22px] pb-3.5 pt-[18px]">
          <div className="font-mono text-[9.5px] uppercase tracking-[1.6px] text-fg-faint">
            Retire · {materialName}
          </div>
          <h2
            id={titleId}
            className="m-0 mt-1 font-serif text-[28px] leading-[1.05] tracking-[-0.6px] text-fg"
          >
            What happened to it?
          </h2>
          <p className="mt-1 font-serif text-[13px] italic text-fg-muted">
            We keep retired material in your Ledger. It won&apos;t appear in active filters.
          </p>
        </div>

        {/* Reason list */}
        <div className="px-[22px]">
          {RETIRE_REASONS.map((r, i) => (
            <label
              key={r.k}
              className={`grid cursor-pointer gap-3 py-2.5 ${i === 0 ? '' : 'border-t border-dashed border-hairline'}`}
              style={{ gridTemplateColumns: '20px 1fr' }}
            >
              <input
                ref={i === 0 ? firstInputRef : undefined}
                type="radio"
                name="retire-reason"
                value={r.k}
                checked={selectedReason === r.k}
                onChange={() => setSelectedReason(r.k)}
                className="sr-only"
              />
              <span
                className={`mt-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border-[1.5px] ${
                  selectedReason === r.k ? 'border-accent' : 'border-hairline-strong'
                }`}
              >
                {selectedReason === r.k && (
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                )}
              </span>
              <div>
                <div
                  className={`font-mono text-[10.5px] uppercase tracking-[1.2px] ${
                    selectedReason === r.k ? 'text-accent' : 'text-fg'
                  }`}
                >
                  {r.k}
                </div>
                <div className="mt-0.5 font-serif text-[12.5px] italic text-fg-muted">
                  {r.body}
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Note textarea */}
        <div className="border-t border-hairline px-[22px] pt-3.5">
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint">
            Note · Optional
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Additional details…"
            rows={3}
            className="w-full rounded-sm border border-hairline bg-bg px-3 py-2.5 font-serif text-[13px] italic text-fg-muted placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* Server error */}
        {serverError && (
          <div
            id="retire-error"
            role="alert"
            aria-live="assertive"
            className="mx-[22px] mt-2 rounded-sm border border-danger bg-danger-bg px-3 py-2 font-sans text-[12px] text-danger"
          >
            {serverError}
          </div>
        )}

        {/* Actions */}
        <div className="mt-2 flex items-center justify-between border-t border-hairline p-[18px]">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="rounded-sm border border-hairline px-3 py-[6px] font-mono text-[10px] uppercase tracking-[1px] text-fg-muted hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutate()}
            disabled={isPending}
            aria-describedby={serverError ? 'retire-error' : undefined}
            className="rounded-md bg-danger px-4 py-2 font-sans text-[12.5px] font-semibold text-bg shadow-none hover:opacity-90 disabled:opacity-50"
          >
            {isPending ? 'Retiring…' : 'Retire material'}
          </button>
        </div>
      </div>
    </div>
  );
}
