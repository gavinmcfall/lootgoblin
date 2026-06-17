// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// LoadDialog — modal for loading a material into a printer.
// A11y mirrors RetireDialog: role=dialog, aria-modal, aria-labelledby,
// Escape + Tab focus trap, focus capture + restore.

import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EmptyHint } from '@/components/shell/atoms';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface PrinterDto {
  id: string;
  name: string;
  kind: string;
  active: boolean;
}

interface LoadDialogProps {
  materialId: string;
  materialName: string;
  onClose: () => void;
}

export function LoadDialog({ materialId, materialName, onClose }: LoadDialogProps) {
  const titleId = useId();
  const printerSelectId = useId();
  const slotInputId = useId();
  const firstInputRef = useRef<HTMLSelectElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  const [printerId, setPrinterId] = useState<string>('');
  const [slotIndex, setSlotIndex] = useState<string>('0');
  const [serverError, setServerError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  // Capture + restore focus.
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

  // Escape closes; Tab/Shift+Tab trapped inside dialog.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && containerRef.current) {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(
          FOCUSABLE_SELECTOR,
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['printers'],
    queryFn: async (): Promise<{ printers: PrinterDto[] }> =>
      (await fetch('/api/v1/forge/printers')).json(),
  });

  // Default to first active printer once list arrives.
  useEffect(() => {
    if (!printerId && data?.printers && data.printers.length > 0) {
      const firstActive = data.printers.find((p) => p.active) ?? data.printers[0]!;
      setPrinterId(firstActive.id);
    }
  }, [data, printerId]);

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      const slot = parseInt(slotIndex, 10);
      if (!printerId) throw new Error('No printer selected');
      if (!Number.isFinite(slot) || slot < 0) throw new Error('Slot must be a non-negative integer');
      const res = await fetch(`/api/v1/materials/${materialId}/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerId, slotIndex: slot }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Material loaded.');
      void queryClient.invalidateQueries({ queryKey: ['material', materialId] });
      void queryClient.invalidateQueries({ queryKey: ['materials'] });
      onClose();
    },
    onError: (err: Error) => {
      setServerError(err.message);
      toast.error(`Failed to load: ${err.message}`);
    },
  });

  const printers = data?.printers ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-6"
    >
      <div
        ref={containerRef}
        className="w-full max-w-[520px] overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg"
      >
        {/* Header */}
        <div className="px-[22px] pb-3.5 pt-[18px]">
          <div className="font-mono text-[9.5px] uppercase tracking-[1.6px] text-fg-faint">
            Load · {materialName}
          </div>
          <h2
            id={titleId}
            className="m-0 mt-1 font-serif text-[24px] leading-[1.05] tracking-[-0.5px] text-fg"
          >
            Where is it going?
          </h2>
          <p className="mt-1 font-serif text-[13px] italic text-fg-muted">
            Pick a printer and slot. The loadout is tracked for consumption telemetry.
          </p>
        </div>

        {/* Body */}
        <div className="space-y-3 border-t border-hairline px-[22px] py-4">
          {isError && <EmptyHint>Failed to load printers.</EmptyHint>}
          {isLoading && <EmptyHint>Loading printers…</EmptyHint>}

          {!isLoading && !isError && printers.length === 0 && (
            <EmptyHint>No printers configured yet.</EmptyHint>
          )}

          {!isLoading && !isError && printers.length > 0 && (
            <>
              <div>
                <label
                  htmlFor={printerSelectId}
                  className="mb-1.5 block font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint"
                >
                  Printer
                </label>
                <select
                  ref={firstInputRef}
                  id={printerSelectId}
                  value={printerId}
                  onChange={(e) => setPrinterId(e.target.value)}
                  disabled={isLoading || isPending}
                  className="w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-sans text-[13px] text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                >
                  {printers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.active}>
                      {p.name} ({p.kind}){!p.active ? ' · inactive' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor={slotInputId}
                  className="mb-1.5 block font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint"
                >
                  Slot index
                </label>
                <input
                  id={slotInputId}
                  type="number"
                  min={0}
                  step={1}
                  value={slotIndex}
                  onChange={(e) => setSlotIndex(e.target.value)}
                  disabled={isPending}
                  className="w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-mono text-[13px] text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                />
              </div>
            </>
          )}
        </div>

        {/* Server error */}
        {serverError && (
          <div
            id="load-error"
            role="alert"
            aria-live="assertive"
            className="mx-[22px] mb-2 rounded-sm border border-danger bg-danger-bg px-3 py-2 font-sans text-[12px] text-danger"
          >
            {serverError}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-hairline p-[18px]">
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
            disabled={isPending || isLoading || !printerId || printers.length === 0}
            aria-describedby={serverError ? 'load-error' : undefined}
            className="rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {isPending ? 'Loading…' : 'Load material'}
          </button>
        </div>
      </div>
    </div>
  );
}
