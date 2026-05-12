'use client';
// GrimoireAttachModal — modal for attaching a slicer profile or print setting
// to a Loot item. Canvas-port #9 (Loot detail) wires this in.
// Exported here but NOT used in any route yet.
//
// Full a11y contract: role=dialog + aria-modal + aria-labelledby + Escape +
// focus capture/restore + Tab focus trap. Mirrors RetireDialog pattern.
//
// Canvas reference: GrimoireAttachModal (page-grimoire.jsx line 105–185).

import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EmptyHint } from '@/components/shell/atoms';

interface SlicerProfileDto {
  id: string;
  name: string;
  slicerKind: string;
}

interface PrintSettingDto {
  id: string;
  name: string;
}

interface GrimoireAttachModalProps {
  lootId: string;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

type AttachKind = 'slicer-profile' | 'print-setting';

export function GrimoireAttachModal({ lootId, onClose }: GrimoireAttachModalProps) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const firstFocusRef = useRef<HTMLButtonElement>(null);

  const [kind, setKind] = useState<AttachKind>('slicer-profile');
  const [selectedId, setSelectedId] = useState<string>('');
  const [note, setNote] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);

  const queryClient = useQueryClient();

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

  // Load profile / setting lists.
  const {
    data: profileData,
    isLoading: profilesLoading,
    isError: profilesError,
  } = useQuery({
    queryKey: ['slicer-profiles'],
    queryFn: async (): Promise<{ profiles: SlicerProfileDto[] }> =>
      (await fetch('/api/v1/grimoire/slicer-profiles')).json(),
    enabled: kind === 'slicer-profile',
  });

  const {
    data: settingData,
    isLoading: settingsLoading,
    isError: settingsError,
  } = useQuery({
    queryKey: ['print-settings'],
    queryFn: async (): Promise<{ settings: PrintSettingDto[] }> =>
      (await fetch('/api/v1/grimoire/print-settings')).json(),
    enabled: kind === 'print-setting',
  });

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        ...(kind === 'slicer-profile' ? { slicerProfileId: selectedId } : { printSettingId: selectedId }),
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      const res = await fetch(`/api/v1/loot/${lootId}/grimoire-attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Attached to Grimoire.');
      void queryClient.invalidateQueries({ queryKey: ['grimoire-attachments', lootId] });
      onClose();
    },
    onError: (err: Error) => {
      setServerError(err.message);
      toast.error(`Failed to attach: ${err.message}`);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) {
      setServerError('Select a profile or setting to attach.');
      return;
    }
    mutate();
  }

  const profiles = profileData?.profiles ?? [];
  const settings = settingData?.settings ?? [];
  const listLoading = kind === 'slicer-profile' ? profilesLoading : settingsLoading;
  const listError = kind === 'slicer-profile' ? profilesError : settingsError;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-6"
    >
      <div
        ref={containerRef}
        className="w-full max-w-[600px] overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg"
      >
        {/* Header */}
        <div className="px-[22px] pb-3.5 pt-[18px]">
          <div className="font-mono text-[9.5px] uppercase tracking-[1.6px] text-accent">
            Grimoire · attach
          </div>
          <h2
            id={titleId}
            className="m-0 mt-1 font-serif text-[28px] leading-[1.05] tracking-[-0.6px] text-fg"
          >
            Attach a slicer spell.
          </h2>
          <p className="mt-1 font-serif text-[13px] italic text-fg-muted">
            Travels with this Loot anywhere it goes.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Kind picker */}
          <div className="grid grid-cols-2 gap-2.5 px-[22px] pb-3.5">
            {(['slicer-profile', 'print-setting'] as AttachKind[]).map((k) => (
              <button
                key={k}
                type="button"
                ref={k === 'slicer-profile' ? firstFocusRef : undefined}
                onClick={() => {
                  setKind(k);
                  setSelectedId('');
                }}
                className={`rounded-md border px-3.5 py-2 text-left font-sans text-[12.5px] transition-colors ${
                  kind === k
                    ? 'border-accent-edge bg-accent-soft text-accent font-semibold'
                    : 'border-hairline bg-transparent text-fg-muted hover:text-fg'
                }`}
              >
                {k === 'slicer-profile' ? 'Slicer profile' : 'Print setting'}
              </button>
            ))}
          </div>

          {/* List selection */}
          <div className="px-[22px] pb-3.5">
            <label
              htmlFor="attach-selection"
              className="mb-1.5 block font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint"
            >
              Select a {kind === 'slicer-profile' ? 'slicer profile' : 'print setting'}
            </label>
            {listError && <EmptyHint>Failed to load {kind === 'slicer-profile' ? 'profiles' : 'settings'}.</EmptyHint>}
            {!listError && listLoading && <EmptyHint>Loading…</EmptyHint>}
            {!listError && !listLoading && (
              <select
                id="attach-selection"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                disabled={isPending}
                className="w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-sans text-[13px] text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              >
                <option value="">— pick one —</option>
                {kind === 'slicer-profile'
                  ? profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)
                  : settings.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>

          {/* Note */}
          <div className="px-[22px] pb-3.5">
            <label
              htmlFor="attach-note"
              className="mb-1.5 block font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint"
            >
              Note · optional
            </label>
            <textarea
              id="attach-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Why this profile for this Loot…"
              className="w-full rounded-sm border border-hairline bg-bg px-[10px] py-2 font-serif text-[13px] italic text-fg-muted placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Server error */}
          {serverError && (
            <div
              id="attach-error"
              role="alert"
              aria-live="assertive"
              className="mx-[22px] mb-3.5 rounded-sm border border-danger bg-danger-bg px-3 py-2 font-sans text-[12px] text-danger"
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
              type="submit"
              disabled={isPending || !selectedId}
              aria-describedby={serverError ? 'attach-error' : undefined}
              className="rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? 'Attaching…' : 'Attach to Grimoire →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
