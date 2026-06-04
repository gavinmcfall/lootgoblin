import { useState } from 'react';
import { startPair, pollStatus, completePair } from '@/lib/pairing';
import { GoblinMark } from './GoblinMark';

export function PairView({ onPaired }: { onPaired: () => void }) {
  const [serverUrl, setServerUrl] = useState('http://lootgoblin.lan:7393');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [busy, setBusy] = useState(false);

  async function begin() {
    if (busy) return;
    setError(null);
    setBusy(true);
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
        } catch {
          // Transient poll errors — keep trying
        }
      }, 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setCode(null);
    setPolling(false);
    setError(null);
  }

  return (
    <div className="lg-pair">
      <div className="lg-pair-header">
        <span className="lg-brand-tile">
          <GoblinMark size={15} color="var(--accent)" />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
          <span className="name">lootgoblin</span>
          <span className="state">not paired</span>
        </div>
      </div>

      {code ? (
        <>
          <h2 className="lg-pair-masthead">Approve to pair.</h2>
          <p className="lg-pair-sub">
            Enter this code in LootGoblin{' '}
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-faint)' }}>
              → Settings → Extensions
            </span>
            .
          </p>

          <div className="lg-code-stage">
            <div className="lg-code-display">{code}</div>
            {polling && (
              <div className="lg-waiting">
                <span className="lg-pulse" />
                waiting for approval
              </div>
            )}
          </div>

          {error && <div className="lg-error">{error}</div>}

          <button type="button" className="lg-btn-ghost" onClick={reset}>
            Try a different URL
          </button>
        </>
      ) : (
        <>
          <h2 className="lg-pair-masthead">Pair your goblin.</h2>
          <p className="lg-pair-sub">
            Point this extension at your LootGoblin server. We&apos;ll show you a code to approve.
          </p>

          <label className="lg-field">
            <span className="lg-field-label">Server URL</span>
            <input
              className="lg-input"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://lootgoblin.lan:7393"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <span className="lg-mono-faint">Usually lan:7393.</span>
          </label>

          <button
            type="button"
            className="lg-btn-primary"
            onClick={begin}
            disabled={busy || !serverUrl.trim()}
          >
            {busy ? 'Requesting code…' : 'Pair'}
          </button>

          {error && <div className="lg-error">{error}</div>}
        </>
      )}
    </div>
  );
}
