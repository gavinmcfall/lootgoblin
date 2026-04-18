'use client';
import { useEffect, useState } from 'react';

interface Pending {
  challengeId: string;
  code: string;
  expiresAt: number;
}

export function ExtensionPairStep({ onDone }: { onDone: () => void }) {
  const [pending, setPending] = useState<Pending[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (cancelled) return;
      try {
        const res = await fetch('/api/v1/pair/pending');
        if (res.ok) {
          const j = await res.json() as { pending: Pending[] };
          if (!cancelled) setPending(j.pending);
        }
      } catch {}
      setTimeout(poll, 3000);
    }
    poll();
    return () => { cancelled = true; };
  }, []);

  async function approve(challengeId: string) {
    await fetch('/api/v1/pair/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId }),
    });
    setPending((prev) => prev.filter((p) => p.challengeId !== challengeId));
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-100">Pair the extension (optional)</h2>
      <p className="text-sm text-slate-400">
        Install the LootGoblin browser extension. Open its popup, point it at this server&apos;s URL, and the pairing code will appear below. Approve it to finish.
      </p>
      <p className="text-xs text-slate-500">
        You can skip this and pair later from Settings → Extensions.
      </p>

      {pending.length === 0 ? (
        <p className="rounded border border-slate-700 bg-slate-900 p-4 text-sm text-slate-500">Waiting for a pairing request…</p>
      ) : (
        <div className="space-y-2">
          {pending.map((p) => (
            <div key={p.challengeId} className="flex items-center justify-between rounded-lg border border-emerald-700 bg-emerald-900/20 p-3">
              <div>
                <div className="font-mono text-xl text-emerald-200">{p.code}</div>
                <div className="text-xs text-emerald-300/70">expires {new Date(p.expiresAt).toLocaleTimeString()}</div>
              </div>
              <button onClick={() => approve(p.challengeId)} className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-500">
                Approve
              </button>
            </div>
          ))}
        </div>
      )}

      <button onClick={onDone} className="w-full rounded border border-slate-700 p-2 text-sm text-slate-300 hover:border-slate-600">
        Finish setup
      </button>
    </div>
  );
}
