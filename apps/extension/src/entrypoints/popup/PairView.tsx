import { useState } from 'react';
import { startPair, pollStatus, completePair } from '@/lib/pairing';

export function PairView({ onPaired }: { onPaired: () => void }) {
  const [serverUrl, setServerUrl] = useState('http://lootgoblin.lan:7393');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  async function begin() {
    setError(null);
    try {
      const r = await startPair(serverUrl);
      setCode(r.code);
      setPolling(true);
      const timer = setInterval(async () => {
        try {
          const s = await pollStatus(serverUrl, r.challengeId);
          if (s.status === 'approved' && s.key) {
            clearInterval(timer);
            await completePair(serverUrl, s.key);
            onPaired();
          } else if (s.status === 'expired') {
            clearInterval(timer);
            setError('Code expired — try again.');
            setCode(null);
            setPolling(false);
          }
        } catch (e) {
          // Transient poll errors — keep trying
        }
      }, 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (code) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-slate-400">Go to LootGoblin → Settings → Extensions and approve this code:</p>
        <div className="text-center text-3xl font-mono tracking-wider text-emerald-300">{code}</div>
        <p className="text-center text-xs text-slate-500">{polling ? 'Waiting for approval…' : ''}</p>
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block text-xs">
        <span className="text-slate-300">Server URL</span>
        <input
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          className="mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 text-slate-100"
          placeholder="http://lootgoblin.lan:7393"
        />
      </label>
      <button onClick={begin} className="w-full rounded bg-emerald-600 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500">
        Pair
      </button>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}
