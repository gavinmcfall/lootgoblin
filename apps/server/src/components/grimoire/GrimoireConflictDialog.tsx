'use client';
// GrimoireConflictDialog — conflict resolution when a new attachment would
// clash with an existing one (same name, different payload). Canvas-port #9
// wires this in from the Loot detail flow.
// Exported here but NOT used in any route yet.
//
// Full a11y contract: role=dialog + aria-modal + aria-labelledby + Escape +
// focus capture/restore + Tab focus trap. Mirrors RetireDialog pattern.
//
// Canvas reference: GrimoireConflict (page-grimoire.jsx line 280–362).

import { useEffect, useId, useRef, useState } from 'react';
import { type Tone } from '@/components/shell/atoms';

export type ConflictResolution = 'keep-existing' | 'replace-incoming' | 'keep-both' | 'merge';

interface ConflictSide {
  /** "existing" or "incoming" */
  side: 'existing' | 'incoming';
  title: string;
  by: string;
  hash: string;
  usedCount: number;
}

interface DiffRow {
  key: string;
  existing: string;
  incoming: string;
}

interface GrimoireConflictDialogProps {
  profileName: string;
  existing: ConflictSide;
  incoming: ConflictSide;
  diffs: DiffRow[];
  onResolve: (resolution: ConflictResolution) => void;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const RESOLUTIONS: { value: ConflictResolution; label: string; sub: string; tone: Tone }[] = [
  {
    value: 'keep-existing',
    label: 'Keep existing',
    sub: 'Discard the incoming spell.',
    tone: 'neutral',
  },
  {
    value: 'replace-incoming',
    label: 'Replace with incoming',
    sub: 'Overwrite. Prints already filed keep referencing the old hash.',
    tone: 'danger',
  },
  {
    value: 'keep-both',
    label: 'Keep both',
    sub: `Rename incoming to "${'"'}(2)${'"'}. Both show in the Grimoire list.`,
    tone: 'accent',
  },
  {
    value: 'merge',
    label: 'Merge — pick per setting',
    sub: 'Open a per-setting picker. For the careful.',
    tone: 'neutral',
  },
];

export function GrimoireConflictDialog({
  profileName,
  existing,
  incoming,
  diffs,
  onResolve,
  onClose,
}: GrimoireConflictDialogProps) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const firstFocusRef = useRef<HTMLButtonElement>(null);

  const [selected, setSelected] = useState<ConflictResolution>('keep-both');

  // Focus capture + restore.
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    firstFocusRef.current?.focus();
    return () => {
      if (
        previousFocusRef.current instanceof HTMLElement ||
        previousFocusRef.current instanceof SVGElement
      ) {
        previousFocusRef.current.focus();
      }
    };
  }, []);

  // Escape closes; Tab trapped within dialog.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && containerRef.current) {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-6"
    >
      <div
        ref={containerRef}
        className="w-full max-w-[800px] overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg"
      >
        {/* Header */}
        <div className="px-[22px] pb-3.5 pt-[18px]">
          <div className="font-mono text-[9.5px] uppercase tracking-[1.6px] text-danger">
            Conflict · same name, different spell
          </div>
          <h2
            id={titleId}
            className="m-0 mt-1 font-serif text-[28px] leading-[1.05] tracking-[-0.6px] text-fg"
          >
            You already have a &ldquo;{profileName}&rdquo; attached.
          </h2>
          <p className="mt-1 font-serif text-[14px] italic text-fg-muted">
            The incoming profile differs from the one on file in {diffs.length} places. Pick which
            version this Loot should keep — or keep both, with distinct names.
          </p>
        </div>

        {/* Side-by-side */}
        <div className="grid grid-cols-2 gap-3 px-[22px] pb-3.5">
          {[existing, incoming].map((c) => (
            <div
              key={c.side}
              className={`rounded-lg border p-4 ${
                c.side === 'incoming' ? 'border-accent-edge bg-accent-soft' : 'border-hairline bg-surface-2'
              }`}
            >
              <div className="mb-2 flex items-baseline gap-2">
                <span
                  className={`font-mono text-[9.5px] uppercase tracking-[0.7px] ${
                    c.side === 'incoming' ? 'text-accent' : 'text-fg-faint'
                  }`}
                >
                  {c.side}
                </span>
                <span className="ml-auto font-mono text-[10px] text-fg-faint">{c.usedCount}× used</span>
              </div>
              <div className="font-serif text-[18px] leading-[1.1] tracking-[-0.3px] text-fg">
                {c.title}
              </div>
              <div className="mt-1 font-mono text-[10px] text-fg-faint">
                {c.by} · {c.hash}
              </div>
            </div>
          ))}
        </div>

        {/* Diff table */}
        {diffs.length > 0 && (
          <div className="mx-[22px] mb-3.5 overflow-hidden rounded-lg border border-hairline bg-surface-2">
            <div className="px-4 py-2.5 font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
              {diffs.length} differences
            </div>
            <div className="font-mono text-[11.5px]">
              {diffs.map((d, i) => (
                <div
                  key={d.key}
                  className={`grid items-baseline gap-3 px-4 py-[5px] ${
                    i < diffs.length - 1 ? 'border-b border-dashed border-hairline' : ''
                  }`}
                  style={{ gridTemplateColumns: '1.3fr 1fr 12px 1fr' }}
                >
                  <span className="text-fg">{d.key}</span>
                  <span className="text-right text-fg-muted">{d.existing}</span>
                  <span className="text-center text-fg-faint">→</span>
                  <span className="text-right text-accent">{d.incoming}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Resolution options */}
        <div className="grid grid-cols-2 gap-3 px-[22px] pb-3.5">
          {RESOLUTIONS.map((r, idx) => (
            <button
              key={r.value}
              type="button"
              ref={idx === 0 ? firstFocusRef : undefined}
              onClick={() => setSelected(r.value)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                selected === r.value
                  ? r.tone === 'accent'
                    ? 'border-accent-edge bg-accent-soft'
                    : r.tone === 'danger'
                    ? 'border-danger bg-danger-bg'
                    : 'border-hairline-strong bg-surface-2'
                  : 'border-hairline bg-transparent hover:bg-surface-2'
              }`}
            >
              <div
                className={`font-sans text-[13.5px] font-semibold ${
                  selected === r.value
                    ? r.tone === 'accent'
                      ? 'text-accent'
                      : r.tone === 'danger'
                      ? 'text-danger'
                      : 'text-fg'
                    : 'text-fg'
                }`}
              >
                {r.label}
              </div>
              <div className="mt-1.5 font-serif text-[12.5px] italic leading-[1.4] text-fg-muted">
                {r.sub}
              </div>
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-hairline p-[18px]">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-hairline px-3 py-[6px] font-mono text-[10px] uppercase tracking-[1px] text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onResolve(selected)}
            className="rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink hover:opacity-90"
          >
            Confirm →
          </button>
        </div>
      </div>
    </div>
  );
}
