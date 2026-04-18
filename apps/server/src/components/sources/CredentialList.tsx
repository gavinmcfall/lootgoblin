'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ReshareHint } from './ReshareHint';

interface Credential {
  id: string;
  label: string;
  status: 'active' | 'expired' | 'revoked';
  lastUsedAt: string | null;
}

export function CredentialList({ sourceId }: { sourceId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['credentials', sourceId],
    queryFn: async (): Promise<{ credentials: Credential[] }> =>
      (await fetch(`/api/v1/source-credentials/${sourceId}`)).json(),
  });

  async function remove(id: string) {
    if (!confirm('Delete this credential?')) return;
    const res = await fetch(`/api/v1/source-credentials/${sourceId}?id=${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.success('Deleted');
      qc.invalidateQueries({ queryKey: ['credentials', sourceId] });
    } else {
      toast.error('Delete failed');
    }
  }

  if (isLoading) return <p className="text-sm text-slate-400">Loading…</p>;
  const creds = data?.credentials ?? [];
  if (creds.length === 0) return <ReshareHint sourceId={sourceId} />;

  return (
    <div className="space-y-2">
      {creds.map((c) => (
        <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900 p-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-100">{c.label}</div>
            <div className="mt-0.5 text-xs text-slate-400">
              <span className={c.status === 'active' ? 'text-emerald-300' : c.status === 'expired' ? 'text-amber-300' : 'text-red-300'}>{c.status}</span>
              {c.lastUsedAt ? <> · last used {new Date(c.lastUsedAt).toLocaleString()}</> : <> · never used</>}
            </div>
          </div>
          <button
            onClick={() => remove(c.id)}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-red-600 hover:text-red-300"
          >
            Remove
          </button>
        </div>
      ))}
      <p className="pt-2 text-xs text-slate-500">To re-share, sign in to {sourceId} in your browser and click <span className="text-slate-300">Share session</span> in the LootGoblin extension popup.</p>
    </div>
  );
}
