'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface Pending {
  challengeId: string;
  code: string;
  expiresAt: number;
  browserFingerprint?: string;
}

export default function ExtensionsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['pair-pending'],
    queryFn: async (): Promise<{ pending: Pending[] }> => (await fetch('/api/v1/pair/pending')).json(),
    refetchInterval: 3000,
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
    } else {
      toast.error('Approve failed');
    }
  }

  const pending = data?.pending ?? [];

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-slate-100">Settings — Extensions</h2>
      <div>
        <h3 className="mb-2 text-sm font-medium text-slate-300">Pending pairings</h3>
        {pending.length === 0 ? (
          <p className="text-sm text-slate-500">None pending. Start the pairing flow from your extension.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.challengeId} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900 p-3">
                <div>
                  <div className="font-mono text-lg text-slate-100">{p.code}</div>
                  <div className="text-xs text-slate-500">
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
      </div>
    </div>
  );
}
