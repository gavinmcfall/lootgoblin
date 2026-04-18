'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface ApiKey {
  id: string;
  name: string;
  scopes: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
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

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-slate-100">Settings — API Keys</h2>

      <form onSubmit={create} className="flex items-end gap-2">
        <label className="block flex-1">
          <span className="text-xs text-slate-400">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm" placeholder="e.g. cli" />
        </label>
        <label className="block flex-1">
          <span className="text-xs text-slate-400">Scopes (csv)</span>
          <input value={scopes} onChange={(e) => setScopes(e.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-xs" />
        </label>
        <button type="submit" className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500">Create</button>
      </form>

      {revealed && (
        <div className="rounded-lg border border-emerald-700 bg-emerald-900/20 p-4">
          <p className="text-sm font-medium text-emerald-200">New key (copy now — will not be shown again):</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-slate-900 p-2 font-mono text-xs text-emerald-200">{revealed}</code>
            <button
              onClick={() => { navigator.clipboard.writeText(revealed); toast.success('Copied'); }}
              className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-900/40"
            >
              Copy
            </button>
            <button onClick={() => setRevealed(null)} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300">
              Done
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (data?.keys.length ?? 0) === 0 ? (
        <p className="text-sm text-slate-500">No API keys yet.</p>
      ) : (
        <div className="space-y-2">
          {data!.keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900 p-3">
              <div>
                <div className="text-sm font-medium text-slate-100">{k.name}</div>
                <div className="font-mono text-xs text-slate-500">{k.scopes}</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : 'never used'}
                </div>
              </div>
              <button
                onClick={() => revoke(k.id)}
                className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-red-600 hover:text-red-300"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
