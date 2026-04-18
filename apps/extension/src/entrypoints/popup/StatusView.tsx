import { useEffect, useState } from 'react';
import { PairedState } from '@/lib/storage';
import { api } from '@/lib/api-client';
import { bc } from '@/lib/browser-compat';

interface Credential {
  id: string;
  label: string;
  status: 'active' | 'expired' | 'revoked';
}

interface SiteConfigMatch {
  siteId: string;
  matches: string[];
}

function matchGlob(pattern: string, url: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(url);
}

export function StatusView({ state, onUnpair }: { state: PairedState; onUnpair: () => void }) {
  const [currentSiteId, setCurrentSiteId] = useState<string | null>(null);
  const [currentDomain, setCurrentDomain] = useState<string | null>(null);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [tab] = await bc.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) return;
        const res = await api<{ configs: SiteConfigMatch[] }>('/api/v1/site-configs');
        const match = res.configs.find((c) => c.matches.some((m) => matchGlob(m, tab.url!)));
        if (match) {
          setCurrentSiteId(match.siteId);
          setCurrentDomain(new URL(tab.url).hostname);
          const cr = await api<{ credentials: Credential[] }>(`/api/v1/source-credentials/${match.siteId}`);
          setCreds(cr.credentials);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  async function share() {
    if (!currentSiteId || !currentDomain) return;
    setSharing(true);
    try {
      const res = await bc.runtime.sendMessage({
        type: 'share-credential',
        payload: { sourceId: currentSiteId, domain: currentDomain },
      });
      if (!res?.ok) {
        setError((res?.error as string) ?? 'Share failed');
        return;
      }
      const cr = await api<{ credentials: Credential[] }>(`/api/v1/source-credentials/${currentSiteId}`);
      setCreds(cr.credentials);
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-400">
        Paired with <span className="font-mono text-slate-200">{state.serverUrl}</span>
      </div>

      {currentSiteId ? (
        <div className="rounded border border-slate-700 bg-slate-900 p-3 space-y-2">
          <div className="text-xs uppercase tracking-wider text-emerald-300">{currentSiteId}</div>
          {creds.length === 0 ? (
            <p className="text-xs text-slate-400">No credential shared yet.</p>
          ) : (
            creds.map((c) => (
              <div key={c.id} className="flex justify-between items-center text-xs">
                <span className="text-slate-200">{c.label}</span>
                <span className={c.status === 'active' ? 'text-emerald-300' : c.status === 'expired' ? 'text-amber-300' : 'text-red-300'}>
                  {c.status}
                </span>
              </div>
            ))
          )}
          <button
            onClick={share}
            disabled={sharing}
            className="mt-2 w-full rounded bg-emerald-600 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-500 disabled:opacity-40"
          >
            {sharing ? 'Sharing\u2026' : creds.length === 0 ? 'Share session' : 'Re-share session'}
          </button>
        </div>
      ) : (
        <p className="rounded border border-slate-700 bg-slate-900 p-3 text-xs text-slate-500">
          No LootGoblin adapter for this site (yet).
        </p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button onClick={onUnpair} className="w-full rounded border border-slate-700 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
        Unpair
      </button>
    </div>
  );
}
