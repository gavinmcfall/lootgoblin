// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SectionTitle, Tile, MetaBadge, EmptyHint } from '@/components/shell/atoms';

interface ApiKey {
  id: string;
  name: string;
  scopes: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['api-keys'],
    queryFn: async (): Promise<{ keys: ApiKey[] }> => (await fetch('/api/v1/api-keys')).json(),
  });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState('items:write,credentials:write');
  const [revealed, setRevealed] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const res = await fetch('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, scopes }),
    });
    if (!res.ok) { toast.error('Create failed'); return; }
    const j = await res.json();
    setRevealed(j.key);
    setName('');
    qc.invalidateQueries({ queryKey: ['api-keys'] });
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this API key?')) return;
    const res = await fetch(`/api/v1/api-keys/${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.success('Revoked');
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    }
  }

  const keys = data?.keys ?? [];

  return (
    <div className="space-y-6">
      <SectionTitle meta={`${keys.length} key${keys.length === 1 ? '' : 's'}`}>API Keys</SectionTitle>

      <Tile className="p-6 max-w-2xl">
        <form onSubmit={create} className="flex items-end gap-2">
          <label htmlFor="key-name" className="block flex-1">
            <span className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">Name</span>
            <input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[13px] text-fg focus:outline-none focus:ring-2 focus:ring-accent-edge"
              placeholder="e.g. cli"
            />
          </label>
          <label htmlFor="key-scopes" className="block flex-1">
            <span className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">Scopes (csv)</span>
            <input
              id="key-scopes"
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
              className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 font-mono text-[13px] text-fg focus:outline-none focus:ring-2 focus:ring-accent-edge"
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-accent-ink hover:opacity-90"
          >
            Create
          </button>
        </form>
      </Tile>

      {revealed && (
        <div className="rounded-md border border-running bg-running-bg p-4">
          <p className="font-mono text-[10px] uppercase tracking-[1px] text-running">New key — copy now, will not be shown again</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded-md bg-surface p-2 font-mono text-[12.5px] text-fg">{revealed}</code>
            <button
              onClick={() => { navigator.clipboard.writeText(revealed); toast.success('Copied'); }}
              className="rounded-md border border-running px-2 py-1 font-mono text-[10px] uppercase tracking-[0.6px] text-running hover:bg-running-bg"
            >
              Copy
            </button>
            <button
              onClick={() => setRevealed(null)}
              className="rounded-md border border-hairline px-2 py-1 font-mono text-[10px] uppercase tracking-[0.6px] text-fg-muted hover:text-fg"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {isError ? (
        <EmptyHint>Failed to load keys.</EmptyHint>
      ) : isLoading ? (
        <EmptyHint>Loading…</EmptyHint>
      ) : keys.length === 0 ? (
        <EmptyHint>No API keys yet.</EmptyHint>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <Tile key={k.id} className="p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[13px] font-medium text-fg">{k.name}</div>
                  <div className="mt-0.5">
                    <MetaBadge tone="neutral">{k.scopes}</MetaBadge>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-fg-faint">
                    {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : 'never used'}
                  </div>
                </div>
                <button
                  onClick={() => revoke(k.id)}
                  className="font-mono text-[10px] uppercase tracking-[0.6px] text-fg-faint hover:text-danger"
                >
                  Revoke
                </button>
              </div>
            </Tile>
          ))}
        </div>
      )}
    </div>
  );
}
