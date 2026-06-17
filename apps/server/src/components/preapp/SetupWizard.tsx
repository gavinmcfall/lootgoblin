// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// First-run setup wizard — client child of the /setup server component.
// Visual treatment ported from page-setup.jsx (SetupCreateAdmin,
// SetupWizardStep, WizardStepper, SetupComplete).
//
// Driven by the real FirstRunState contract:
//   reason: 'no-admin'       → create admin  (POST /api/setup, FormData)
//   reason: 'pending-wizard' → one step per pendingKey (POST /api/v1/setup/wizard)
//   needsSetup: false        → complete → /login
//
// Degradations vs the design mock are documented inline at each site.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FirstRunState } from '@/setup/first-run';
import { Field, PrimaryButton } from '@/components/preapp/primitives';

// ── per-key copy ───────────────────────────────────────────────────────────
// Only STASH_ROOTS is a real WIZARD_DEFERRABLE_KEY today. Unknown future keys
// fall back to a generic text field with the raw key as the label.
interface KeyMeta {
  kind: 'path' | 'text';
  title: string;
  subtitle: string;
  label: string;
  helper: string;
  placeholder: string;
}

function metaForKey(key: string): KeyMeta {
  if (key === 'STASH_ROOTS') {
    return {
      kind: 'path',
      title: 'Where should the Stash live?',
      subtitle:
        "A folder on disk where fresh Loot lands. We'll create it if it doesn't exist.",
      label: 'Stash root',
      helper:
        'Container-relative path. Mount it from the host with a bind, not a named volume.',
      placeholder: '/data/stash',
    };
  }
  return {
    kind: 'text',
    title: 'One more value to set.',
    subtitle: 'Provide a value for this configuration key to continue.',
    label: key,
    helper: 'Raw configuration value.',
    placeholder: '',
  };
}

// ── stepper ──────────────────────────────────────────────────────────────-
function WizardStepper({
  step,
  total,
  completedLabels,
}: {
  step: number;
  total: number;
  completedLabels: string[];
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-1">
        {Array.from({ length: total }).map((_, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <div
              key={i}
              className={`h-1 flex-1 rounded-sm transition-colors ${
                done
                  ? 'bg-accent'
                  : active
                    ? 'border border-accent bg-accent-edge'
                    : 'bg-surface-2'
              }`}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[1.4px] text-fg-faint">
          Step {step + 1} of {total}
        </span>
        {completedLabels.length > 0 && (
          <span className="font-mono text-[10px] tracking-[0.5px] text-fg-ghost">
            done: {completedLabels.join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}

type Phase =
  | { kind: 'no-admin'; pendingKeys: string[] }
  | { kind: 'wizard'; pendingKeys: string[] }
  | { kind: 'complete' };

function phaseFromState(state: FirstRunState): Phase {
  if (!state.needsSetup) return { kind: 'complete' };
  if (state.reason === 'no-admin')
    return { kind: 'no-admin', pendingKeys: state.pendingKeys };
  return { kind: 'wizard', pendingKeys: state.pendingKeys };
}

export function SetupWizard({ initialState }: { initialState: FirstRunState }) {
  const [phase, setPhase] = useState<Phase>(() => phaseFromState(initialState));

  // Values tracked through the flow so the completion receipt shows only real,
  // user-entered values.
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const [stashRoot, setStashRoot] = useState<string | null>(null);

  // Count of wizard keys already saved this session. This is the single source
  // of truth for the stepper position: the admin step is index 0, so the
  // current wizard key sits at index (1 + completedWizardKeys). Total is
  // derived from the same count plus the keys still live, so the stepper stays
  // correct even if the server's pending set grows mid-wizard (e.g. a second
  // deferrable key appears on a later resolve()).
  const [completedWizardKeys, setCompletedWizardKeys] = useState(0);

  if (phase.kind === 'no-admin') {
    return (
      <CreateAdminStep
        onCreated={(email, next) => {
          setAdminEmail(email);
          setPhase(phaseFromState(next));
        }}
      />
    );
  }

  if (phase.kind === 'wizard' && phase.pendingKeys.length > 0) {
    const key = phase.pendingKeys[0]!;
    const total = 1 + completedWizardKeys + phase.pendingKeys.length;
    const stepIndex = 1 + completedWizardKeys;
    return (
      // key={key} gives each distinct pending key a fresh instance, so its
      // internal value/error/submitting state never leaks from a previous key.
      <WizardKeyStep
        key={key}
        fieldKey={key}
        step={stepIndex}
        total={total}
        completedLabels={['Admin account']}
        onSaved={(value, next) => {
          if (key === 'STASH_ROOTS') setStashRoot(value);
          setCompletedWizardKeys((n) => n + 1);
          setPhase(phaseFromState(next));
        }}
      />
    );
  }

  // complete (or wizard with no keys left)
  return <CompleteStep adminEmail={adminEmail} stashRoot={stashRoot} />;
}

// ── PHASE 1 — Create admin ─────────────────────────────────────────────────
function CreateAdminStep({
  onCreated,
}: {
  onCreated: (email: string, next: FirstRunState) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // The setup route reads req.formData() — submit form-encoded, NOT JSON.
      // Note: /api/setup intentionally does NOT establish a session — it
      // discards the signUpEmail result and only creates the user — so the
      // admin must sign in at /login afterward. Don't "fix" this as a bug.
      const form = new FormData();
      form.set('name', name);
      form.set('email', email);
      form.set('password', password);
      const res = await fetch('/api/setup', { method: 'POST', body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not create the admin account.');
        setSubmitting(false);
        return;
      }
      // Re-read state to learn the next phase. Guard res.ok so a 500/HTML
      // response doesn't silently land the user on the completion screen.
      const statusRes = await fetch('/api/v1/setup/status');
      if (!statusRes.ok) {
        setError('Account created, but could not load the next step. Reload to continue.');
        setSubmitting(false);
        return;
      }
      const next = (await statusRes.json()) as FirstRunState;
      onCreated(email, next);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="flex w-[460px] flex-col gap-6">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          First run
        </div>
        <h1 className="mt-1.5 font-serif text-[44px] font-normal italic leading-[1.05] tracking-[-0.8px] text-fg">
          Welcome to LootGoblin.
        </h1>
        <div className="mt-3 max-w-[420px] font-sans text-[13.5px] leading-[1.55] text-fg-muted">
          First, let&apos;s set up your keep. The admin account you create here can
          invite others later and decides who sees what.
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface p-6 shadow-md"
      >
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-sm border border-danger bg-danger-bg px-3 py-2 font-sans text-[12px] text-danger"
          >
            {error}
          </div>
        )}

        <div className="flex items-center gap-2.5 rounded-sm border border-hairline bg-surface-2 px-3 py-2">
          <span
            className="h-1.5 w-1.5 rounded-full bg-running"
            style={{ boxShadow: '0 0 0 3px var(--running-bg)' }}
          />
          <span className="font-mono text-[10.5px] tracking-[0.5px] text-fg-muted">
            no admin exists yet · <span className="text-fg">creating the first one</span>
          </span>
        </div>

        <Field
          id="name"
          label="Your name"
          value={name}
          onChange={setName}
          placeholder="Gavin McFall"
          autoComplete="name"
          autoFocus
          required
        />
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          autoComplete="email"
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="at least 12 characters"
          autoComplete="new-password"
          required
          mono
          hint="Stored as an argon2id hash. Pick something a password manager can remember."
        />

        <PrimaryButton label="Create the keep →" loading={submitting} />
      </form>

      <div className="max-w-[420px] self-center text-center font-sans text-[11px] leading-[1.5] text-fg-faint">
        Self-hosted means your data stays where you put it. No telemetry leaves the
        container unless you turn it on.
      </div>
    </div>
  );
}

// ── PHASE 2 — Per-key wizard step ──────────────────────────────────────────
function WizardKeyStep({
  fieldKey,
  step,
  total,
  completedLabels,
  onSaved,
}: {
  fieldKey: string;
  step: number;
  total: number;
  completedLabels: string[];
  onSaved: (value: string, next: FirstRunState) => void;
}) {
  const meta = metaForKey(fieldKey);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) {
      setError('A value is required to continue.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/setup/wizard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: fieldKey, value: value.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not save this value.');
        setSubmitting(false);
        return;
      }
      const next = (await res.json()) as FirstRunState;
      onSaved(value.trim(), next);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  const isLast = step === total - 1;

  return (
    <div className="flex w-[480px] flex-col gap-6">
      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Set up your keep
        </div>
        <WizardStepper step={step} total={total} completedLabels={completedLabels} />
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-[18px] rounded-lg border border-hairline bg-surface p-[26px] shadow-md"
      >
        <div>
          <h2 className="m-0 font-serif text-[28px] font-normal italic leading-[1.1] tracking-[-0.5px] text-fg">
            {meta.title}
          </h2>
          <div className="mt-2 font-sans text-[13px] leading-[1.5] text-fg-muted">
            {meta.subtitle}
          </div>
        </div>

        {/* Key indicator — quiet mono chip. */}
        <div className="self-start rounded-sm border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[10px] tracking-[0.5px] text-fg-faint">
          key · <span className="text-fg">{fieldKey}</span>
        </div>

        {/* DEGRADED: no 'browse' path-picker suffix (no directory-browser
            backend) and no 'Skip this step' (the one real key is required). */}
        <Field
          id="wizard-value"
          label={meta.label}
          value={value}
          onChange={setValue}
          placeholder={meta.placeholder}
          hint={meta.helper}
          error={error ?? undefined}
          mono={meta.kind === 'path'}
          autoFocus
          inputMode={meta.kind === 'path' ? 'text' : undefined}
        />

        {/* No "← Back": the admin step is not re-enterable (the account is
            already created), and STASH_ROOTS is the only real wizard key.
            Real phase-rewind belongs with any future multi-key work. */}
        <div className="mt-1 flex items-center gap-2.5">
          <div className="flex-1" />
          <PrimaryButton
            full={false}
            label={isLast ? 'Finish setup →' : 'Save and continue →'}
            loading={submitting}
          />
        </div>
      </form>
    </div>
  );
}

// ── SETUP COMPLETE ─────────────────────────────────────────────────────────
function CompleteStep({
  adminEmail,
  stashRoot,
}: {
  adminEmail: string | null;
  stashRoot: string | null;
}) {
  // Receipt shows only real configured values we tracked through the flow.
  // After a reload neither is known — omit rather than fake (DEGRADED: the
  // mock's instance.public_url / libraries.first / integrations.manyfold lines
  // are dropped entirely as they are not real wizard keys).
  const router = useRouter();
  const receipt: { k: string; v: string }[] = [];
  if (adminEmail) receipt.push({ k: 'admin', v: adminEmail });
  if (stashRoot) receipt.push({ k: 'STASH_ROOTS', v: stashRoot });

  return (
    <div className="flex w-[480px] flex-col items-center gap-6 text-center">
      <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-accent">
        <svg width="32" height="32" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <path
            d="M6 14l5 5 11-12"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div>
        <div className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Setup complete
        </div>
        <h1 className="mt-2 font-serif text-[38px] font-normal italic leading-[1.1] tracking-[-0.6px] text-fg">
          the goblin is ready.
        </h1>
        <div className="mx-auto mt-3 max-w-[420px] font-sans text-[13.5px] leading-[1.55] text-fg-muted">
          Your keep is configured. Sign in to start filing Loot — install the browser
          extension when you&apos;re ready to scrape your first model.
        </div>
      </div>

      {receipt.length > 0 && (
        <div className="flex w-full flex-col gap-2 rounded-md border border-hairline bg-surface p-4 text-left">
          <div className="mb-0.5 font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
            what&apos;s filed
          </div>
          {receipt.map((r) => (
            <div
              key={r.k}
              className="grid grid-cols-[1fr_auto] items-baseline gap-2.5"
            >
              <span className="font-mono text-[11px] tracking-[0.3px] text-fg-faint">
                {r.k}
              </span>
              <span className="break-all font-sans text-[12px] font-medium text-fg">
                {r.v}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="w-full">
        <PrimaryButton type="button" label="Sign in →" onClick={() => router.push('/login')} />
      </div>

      <div className="font-sans text-[11px] leading-[1.5] text-fg-faint">
        You can revisit every one of these in{' '}
        <span className="text-fg">Settings · The Rig</span> later.
      </div>
    </div>
  );
}
