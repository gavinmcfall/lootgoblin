'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface Pending {
  challengeId: string;
  code: string;
  expiresAt: number;
  browserFingerprint?: string;
}

interface ApiKey {
  id: string;
  name: string;
  scopes: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function ExtensionsPage() {
  const qc = useQueryClient();

  const { data: pendingData } = useQuery({
    queryKey: ['pair-pending'],
    queryFn: async (): Promise<{ pending: Pending[] }> => (await fetch('/api/v1/pair/pending')).json(),
    refetchInterval: 3000,
  });

  const { data: keysData } = useQuery({
    queryKey: ['api-keys'],
    queryFn: async (): Promise<{ keys: ApiKey[] }> => (await fetch('/api/v1/api-keys')).json(),
  });

  async function approve(challengeId: string) {
    const res = await fetch('/api/v1/pair/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId }),
    });
    if (res.ok) {
      toast.success('Approved');
      qc.invalidateQueries({ queryKey: ['pair-pending'] });
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

  const pending = pendingData?.pending ?? [];
  // Extension pairings are api_keys whose name includes 'extension' (default from pair approval).
  // User-renamed keys may have custom names — include those too by default, but filter out keys
  // that clearly belong to CLIs/webhooks etc. For v1 simplicity, show ALL active keys here;
  // /settings/api-keys is the page for raw-key-style tokens.
  const activeKeys = keysData?.keys ?? [];

  return (
    <div className="space-y-8">
      <h2 className="text-xl font-semibold text-slate-100">Settings — Extensions</h2>

      {/* Pending pair requests */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-slate-300">Pending pairings</h3>
        {pending.length === 0 ? (
          <p className="text-sm text-slate-500">None pending. Start pairing from an extension.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.challengeId} className="flex items-center justify-between rounded-lg border border-emerald-700 bg-emerald-900/20 p-3">
                <div>
                  <div className="font-mono text-xl text-emerald-100">{p.code}</div>
                  <div className="text-xs text-emerald-300/70">
                    {p.browserFingerprint ? `${p.browserFingerprint} · ` : ''}
                    expires {new Date(p.expiresAt).toLocaleTimeString()}
                  </div>
                </div>
                <button
                  onClick={() => approve(p.challengeId)}
                  className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-500"
                >
                  Approve
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Active extension pairings (api keys) */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-slate-300">Active pairings</h3>
        {activeKeys.length === 0 ? (
          <p className="text-sm text-slate-500">No active pairings.</p>
        ) : (
          <div className="space-y-2">
            {activeKeys.map((k) => (
              <div key={k.id} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900 p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-100">{k.name}</div>
                  <div className="mt-0.5 font-mono text-xs text-slate-500">{k.scopes}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : 'never used'} · paired {new Date(k.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => rename(k)}
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => revoke(k)}
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 hover:border-red-600 hover:text-red-300"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
