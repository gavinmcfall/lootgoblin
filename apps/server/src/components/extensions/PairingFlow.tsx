'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MetaBadge } from '@/components/shell/atoms';
import { PairingCodeDigits } from './PairingCodeDigits';
import { PairingCountdown } from './PairingCountdown';

// -------------------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------------------

export interface ApiKey {
  id: string;
  name: string;
  scopes: string;
  lastUsedAt: string | null;
  createdAt: string;
}

type PairingState = 'waiting' | 'connected';

interface ChallengeData {
  challengeId: string;
  code: string;
  /** Derived client-side: Date.now() + 90_000 */
  expiresAt: number;
}

interface StatusData {
  status: 'pending' | 'approved' | 'expired' | 'unknown';
  key?: ApiKey;
}

interface PairingFlowProps {
  onConnected: (apiKey: ApiKey) => void;
  onCancel: () => void;
}

// -------------------------------------------------------------------------------------
// VaultGlyph — server-side SVG (from canvas WebAppConnected)
// -------------------------------------------------------------------------------------

function VaultGlyph({ size = 100 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <defs>
        <radialGradient id="vaultGlowPF" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.55" />
          <stop offset="60%" stopColor="var(--color-accent)" stopOpacity="0.12" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill="url(#vaultGlowPF)" />
      <circle
        cx="50"
        cy="50"
        r="32"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
        fill="none"
        opacity="0.55"
      />
      <circle
        cx="50"
        cy="50"
        r="24"
        stroke="var(--color-accent)"
        strokeWidth="2"
        fill="none"
      />
      {[0, 45, 90, 135].map((a) => (
        <line
          key={a}
          x1="50"
          y1="50"
          x2={50 + 24 * Math.cos((a * Math.PI) / 180)}
          y2={50 + 24 * Math.sin((a * Math.PI) / 180)}
          stroke="var(--color-accent)"
          strokeWidth="1.2"
          opacity="0.65"
        />
      ))}
      <circle cx="50" cy="50" r="7" fill="var(--color-accent)" />
      <circle cx="50" cy="50" r="3" fill="var(--color-bg)" />
    </svg>
  );
}

// -------------------------------------------------------------------------------------
// GoblinSigil — decorative SVG shown on the code card
// -------------------------------------------------------------------------------------

function GoblinSigil({ size = 72, pulse = false }: { size?: number; pulse?: boolean }) {
  return (
    <div
      className={[
        'flex items-center justify-center rounded-full',
        pulse ? 'motion-safe:animate-[sigilPulse_1.8s_ease-in-out_infinite]' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        width: size,
        height: size,
        background:
          'radial-gradient(circle at 50% 50%, var(--color-accent) 0%, var(--color-accent-edge) 45%, transparent 80%)',
      }}
    >
      <svg
        width={size * 0.55}
        height={size * 0.55}
        viewBox="0 0 40 40"
        fill="none"
      >
        <path
          d="M20 4 C11 4 5 11 5 20 L5 32 C5 34 7 36 9 36 L31 36 C33 36 35 34 35 32 L35 20 C35 11 29 4 20 4 Z"
          stroke="var(--color-bg)"
          strokeWidth="1.8"
          fill="var(--color-bg)"
          opacity="0.9"
        />
        <circle cx="14" cy="20" r="2.3" fill="var(--color-accent)" />
        <circle cx="26" cy="20" r="2.3" fill="var(--color-accent)" />
        <path d="M18 26 L20 30 L22 26 Z" fill="var(--color-accent)" />
      </svg>
      <style>{`
        @keyframes sigilPulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50%       { transform: scale(1.06); opacity: 0.85; }
        }
      `}</style>
    </div>
  );
}

// -------------------------------------------------------------------------------------
// PairingFlow — the main state machine component
// -------------------------------------------------------------------------------------

export function PairingFlow({ onConnected, onCancel }: PairingFlowProps) {
  const [pairingState, setPairingState] = useState<PairingState>('waiting');
  const [challenge, setChallenge] = useState<ChallengeData | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  // Poll status while a challenge is live (until 'connected').
  const pollEnabled = pairingState !== 'connected' && challenge !== null;

  const { data: statusData, isError: statusIsError } = useQuery<StatusData>({
    queryKey: ['pair', 'status', challenge?.challengeId],
    queryFn: async () => {
      const res = await fetch(`/api/v1/pair/status?challengeId=${challenge!.challengeId}`);
      return res.json() as Promise<StatusData>;
    },
    enabled: pollEnabled,
    refetchInterval: pollEnabled ? 1000 : false,
    staleTime: 0,
  });

  // React to status updates.
  useEffect(() => {
    if (!statusData) return;
    if (statusData.status === 'approved' && statusData.key) {
      setPairingState('connected');
      onConnected(statusData.key);
    } else if (statusData.status === 'expired' || statusData.status === 'unknown') {
      // Code expired — reset so the user can try again.
      setChallenge(null);
      setPairingState('waiting');
    }
    // 'pending' is the steady state — keep showing the code; no action needed.
  }, [statusData, onConnected]);

  async function startPairing() {
    setIsStarting(true);
    try {
      const res = await fetch('/api/v1/pair/challenge', { method: 'POST' });
      const data = (await res.json()) as { challengeId: string; code: string };
      setChallenge({
        challengeId: data.challengeId,
        code: data.code,
        expiresAt: Date.now() + 90_000,
      });
      setPairingState('waiting');
    } finally {
      setIsStarting(false);
    }
  }

  function cancelPairing() {
    setChallenge(null);
    setPairingState('waiting');
    onCancel();
  }

  // ── No challenge yet — show start prompt ─────────────────────────────────────

  if (!challenge) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-md border border-dashed border-hairline bg-surface-2 p-8 text-center">
        <GoblinSigil size={64} />
        <div className="font-serif text-[18px] tracking-[-0.3px] text-fg">
          Pair a new extension
        </div>
        <p className="max-w-sm font-serif text-[13px] italic leading-relaxed text-fg-muted">
          Generate a one-time code, then enter it in the extension popup to link your browser.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={startPairing}
            disabled={isStarting}
            className="rounded-md bg-accent px-4 py-2 font-sans text-[13px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {isStarting ? 'Generating…' : '+ Pair new extension'}
          </button>
          <button
            type="button"
            onClick={cancelPairing}
            className="rounded-md border border-hairline px-4 py-2 font-sans text-[13px] text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Connected state ──────────────────────────────────────────────────────────

  if (pairingState === 'connected') {
    return (
      <div className="flex flex-col items-center gap-4 rounded-md border border-success bg-success-bg p-8 text-center">
        <VaultGlyph size={80} />
        <MetaBadge tone="success">Extension connected</MetaBadge>
        <div className="font-serif text-[24px] tracking-[-0.6px] text-fg">
          The goblin has your key.
        </div>
        <p className="font-serif text-[13px] italic text-fg-muted">
          you can close this — the extension takes over from here.
        </p>
      </div>
    );
  }

  // ── Waiting + Connecting states — two-column code reveal ────────────────────

  return (
    <div className="overflow-hidden rounded-md border border-hairline">
      <div className="flex min-h-[360px] items-stretch">

        {/* Left column — title + instructions */}
        <div className="flex flex-1 flex-col justify-center gap-4 p-10">
          {/* Eyebrow */}
          <div className="font-mono text-[10px] uppercase tracking-[2px] text-accent">
            Step 2 of 2 · Pair the extension
          </div>

          {/* Title */}
          <h2 className="m-0 font-serif text-[38px] font-normal leading-[1.05] tracking-[-1px] text-fg">
            Hand the goblin<br />your key.
          </h2>

          {/* Sub */}
          <p className="max-w-sm font-serif text-[15px] italic leading-[1.45] text-fg-muted">
            Open the extension in your browser and type this code. We'll do the rest.
          </p>

          {/* Steps */}
          <ol className="mt-3 flex list-none flex-col gap-2.5 p-0">
            {[
              <>Click the extension icon — top-right corner of your browser.</>,
              <>
                Choose{' '}
                <strong className="font-semibold text-fg">Pair with code</strong>.
              </>,
              <>
                Type the six digits. They expire in{' '}
                <PairingCountdown expiresAt={challenge.expiresAt} />.
              </>,
            ].map((txt, i) => (
              <li key={i} className="flex items-baseline gap-3">
                <span className="shrink-0 rounded-sm border border-accent-edge px-1.5 py-px font-mono text-[10px] text-accent">
                  {i + 1}
                </span>
                <span className="font-sans text-[13px] text-fg-muted">{txt}</span>
              </li>
            ))}
          </ol>

          {/* Cancel */}
          <div className="mt-2">
            <button
              type="button"
              onClick={cancelPairing}
              className="font-mono text-[10px] uppercase tracking-[0.6px] text-fg-faint hover:text-fg-muted"
            >
              Cancel
            </button>
          </div>
        </div>

        {/* Right column — the code card */}
        <div className="flex flex-1 flex-col items-center justify-center gap-5 border-l border-hairline bg-surface p-10">
          {/* Goblin sigil */}
          <GoblinSigil size={64} />

          {/* One-time code label */}
          <div className="font-mono text-[9.5px] uppercase tracking-[2px] text-fg-faint">
            One-time pairing code
          </div>

          {/* Big digit grid */}
          <PairingCodeDigits code={challenge.code} size="lg" />

          {/* Waiting caption */}
          <p className="font-serif text-[13px] italic text-fg-muted">
            waiting for the extension…
          </p>

          {/* Status-poll error — transient inline mono caption */}
          {statusIsError && (
            <div className="font-mono text-[10px] uppercase tracking-[1px] text-danger">
              Status check failed. Retrying…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
