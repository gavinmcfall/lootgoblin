// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SectionTitle, Tile, MetaBadge, EmptyHint } from '@/components/shell/atoms';
import { PairingFlow, type ApiKey } from '@/components/extensions/PairingFlow';

interface Pending {
  challengeId: string;
  code: string;
  expiresAt: number;
  browserFingerprint?: string;
}

// 1.8s — let the user see the connected state before closing the flow
const AUTO_DISMISS_MS = 1_800;

export default function ExtensionsPage() {
  const qc = useQueryClient();
  const [showPairingFlow, setShowPairingFlow] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending dismiss timer on unmount to avoid setState-after-unmount.
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  // ── Queries ──────────────────────────────────────────────────────────────────

  const {
    data: pendingData,
    isError: pendingIsError,
    isLoading: pendingIsLoading,
  } = useQuery({
    queryKey: ['pair', 'pending'],
    queryFn: async (): Promise<{ pending: Pending[] }> =>
      (await fetch('/api/v1/pair/pending')).json(),
    refetchInterval: 3000,
    staleTime: 3_000,
  });

  const {
    data: keysData,
    isError: keysIsError,
    isLoading: keysIsLoading,
  } = useQuery({
    queryKey: ['api-keys'],
    queryFn: async (): Promise<{ keys: ApiKey[] }> =>
      (await fetch('/api/v1/api-keys')).json(),
  });

  // ── Handlers ─────────────────────────────────────────────────────────────────

  async function approve(challengeId: string) {
    const res = await fetch('/api/v1/pair/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId }),
    });
    if (res.ok) {
      toast.success('Approved');
      qc.invalidateQueries({ queryKey: ['pair', 'pending'] });
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    } else {
      toast.error('Approve failed');
    }
  }

  async function rename(k: ApiKey) {
    const next = window.prompt('Rename this extension pairing:', k.name);
    if (!next || next === k.name) return;
    const res = await fetch(`/api/v1/api-keys/${k.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: next }),
    });
    if (res.ok) {
      toast.success('Renamed');
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    } else {
      toast.error('Rename failed');
    }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke "${k.name}"? The extension using this key will be logged out.`)) return;
    const res = await fetch(`/api/v1/api-keys/${k.id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.success('Revoked');
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    } else {
      toast.error('Revoke failed');
    }
  }

  const handleConnected = useCallback(
    (apiKey: ApiKey) => {
      toast.success(`"${apiKey.name}" paired successfully`);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      qc.invalidateQueries({ queryKey: ['pair', 'pending'] });
      // Brief delay so the user sees the connected state, then dismiss flow.
      dismissTimerRef.current = setTimeout(
        () => setShowPairingFlow(false),
        AUTO_DISMISS_MS,
      );
    },
    [qc],
  );

  // ── Derived data ─────────────────────────────────────────────────────────────

  const pending = pendingData?.pending ?? [];
  const activeKeys = keysData?.keys ?? [];

  return (
    <div className="space-y-8">
      <SectionTitle meta={`${activeKeys.length} paired`}>Browser Extensions</SectionTitle>

      {/* ── Pairing flow ─────────────────────────────────────────────────────── */}
      <section>
        <div className="mb-3.5 flex items-baseline justify-between">
          <SectionTitle as="h3">Pair a new extension</SectionTitle>
          {!showPairingFlow && (
            <button
              type="button"
              onClick={() => setShowPairingFlow(true)}
              className="shrink-0 rounded-md bg-accent px-3.5 py-1.5 font-sans text-[12.5px] font-semibold text-accent-ink hover:opacity-90"
            >
              + Pair new extension
            </button>
          )}
        </div>

        {showPairingFlow ? (
          <PairingFlow
            onConnected={handleConnected}
            onCancel={() => setShowPairingFlow(false)}
          />
        ) : (
          <div className="mt-2">
            {pendingIsError ? (
              <EmptyHint>Failed to load pending pairings.</EmptyHint>
            ) : pendingIsLoading ? (
              <EmptyHint>Loading…</EmptyHint>
            ) : pending.length === 0 ? (
              <EmptyHint>
                No pending pairings. Click "+ Pair new extension" above to get started.
              </EmptyHint>
            ) : (
              <div className="space-y-2">
                {pending.map((p) => (
                  <div
                    key={p.challengeId}
                    className="rounded-md border border-running bg-running-bg p-3"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-mono text-[16px] tracking-[3px] text-running">
                          {p.code}
                        </div>
                        <div className="font-mono text-[10px] text-fg-faint">
                          {p.browserFingerprint ? `${p.browserFingerprint} · ` : ''}
                          expires {new Date(p.expiresAt).toLocaleTimeString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => approve(p.challengeId)}
                        className="rounded-md bg-accent px-3.5 py-1.5 font-sans text-[12.5px] font-semibold text-accent-ink hover:opacity-90"
                      >
                        Approve
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Active pairings ──────────────────────────────────────────────────── */}
      <section>
        <SectionTitle as="h3">Active pairings</SectionTitle>
        <div className="mt-2">
          {keysIsError ? (
            <EmptyHint>Failed to load paired extensions.</EmptyHint>
          ) : keysIsLoading ? (
            <EmptyHint>Loading…</EmptyHint>
          ) : activeKeys.length === 0 ? (
            <EmptyHint>No active pairings.</EmptyHint>
          ) : (
            <div className="space-y-2">
              {activeKeys.map((k) => (
                <Tile key={k.id} className="p-3">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-fg">{k.name}</div>
                      <div className="mt-0.5">
                        <MetaBadge tone="neutral">{k.scopes}</MetaBadge>
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-fg-faint">
                        {k.lastUsedAt
                          ? `last used ${new Date(k.lastUsedAt).toLocaleString()}`
                          : 'never used'}{' '}
                        · paired {new Date(k.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => rename(k)}
                        className="rounded-md border border-hairline px-2 py-1 font-mono text-[10px] uppercase tracking-[0.6px] text-fg-muted hover:text-fg"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => revoke(k)}
                        className="font-mono text-[10px] uppercase tracking-[0.6px] text-fg-faint hover:text-danger"
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                </Tile>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
