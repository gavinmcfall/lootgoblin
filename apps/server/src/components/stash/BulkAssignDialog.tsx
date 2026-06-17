// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import Link from 'next/link';

interface Destination {
  id: string;
  name: string;
  config: { path: string; namingTemplate: string };
}

export function BulkAssignDialog({
  ids,
  onClose,
}: {
  ids: string[];
  onClose: () => void;
}) {
  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [destId, setDestId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const qc = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    fetch('/api/v1/hoard')
      .then((r) => r.json())
      .then((d: { destinations: Destination[] }) => setDestinations(d.destinations));
  }, []);

  // Capture trigger element on mount; restore focus on unmount.
  useEffect(() => {
    previousActiveElement.current = document.activeElement as HTMLElement | null;
    const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    firstFocusable?.focus();
    return () => {
      previousActiveElement.current?.focus();
    };
  }, []);

  // Escape closes the dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function apply() {
    if (!destId) return;
    setSubmitting(true);
    try {
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`/api/v1/stash/${id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hoardId: destId }),
          }),
        ),
      );
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        toast.error(`${failed} of ${ids.length} failed`);
      } else {
        toast.success(`Assigned ${ids.length} item${ids.length === 1 ? '' : 's'}`);
      }
      qc.invalidateQueries({ queryKey: ['items'] });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-assign-title"
        className="w-full max-w-md rounded-lg border border-hairline-strong bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="bulk-assign-title"
          className="m-0 font-serif text-[18px] font-normal tracking-[-0.3px] text-fg"
        >
          Assign library to {ids.length} item{ids.length === 1 ? '' : 's'}
        </h2>

        <div className="mt-4 space-y-2">
          {!destinations ? (
            <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">
              Loading libraries…
            </p>
          ) : destinations.length === 0 ? (
            <p className="text-[13px] text-fg-muted">
              No libraries configured.{' '}
              <Link href="/hoard/new" className="text-accent underline">
                Create one
              </Link>
              .
            </p>
          ) : (
            destinations.map((d) => (
              <label
                key={d.id}
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                  destId === d.id
                    ? 'border-accent-edge bg-accent-soft'
                    : 'border-hairline hover:border-hairline-strong hover:bg-surface-hi'
                }`}
              >
                <input
                  type="radio"
                  name="dest"
                  value={d.id}
                  checked={destId === d.id}
                  onChange={() => setDestId(d.id)}
                  className="mt-1"
                />
                <div>
                  <div className="text-[13.5px] font-medium text-fg">{d.name}</div>
                  <div className="font-mono text-[10.5px] text-fg-faint">
                    {d.config.path} · {d.config.namingTemplate}
                  </div>
                </div>
              </label>
            ))
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-hairline px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.6px] text-fg-muted transition-colors hover:bg-surface-hi"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={!destId || submitting}
            className="rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-accent-ink shadow-sm transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Assigning…' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  );
}
