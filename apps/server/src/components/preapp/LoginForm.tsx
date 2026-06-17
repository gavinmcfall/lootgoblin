// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Login form — client child of the /login server component.
// Visual treatment ported from page-login.jsx (LoginCard + LoginSSO).
// Wired to BetterAuth: POST /api/auth/sign-in/email for password sign-in and
// authClient.signIn.oauth2({ providerId: 'oidc' }) for SSO.

import { useState } from 'react';
import Link from 'next/link';
import { createAuthClient } from 'better-auth/client';
import { genericOAuthClient } from 'better-auth/client/plugins';
import { Field, PrimaryButton, GhostButton } from '@/components/preapp/primitives';

// SSO uses the genericOAuth client plugin, mirroring the server's
// genericOAuth({ providerId: 'oidc' }) config in src/auth/index.ts.
const authClient = createAuthClient({ plugins: [genericOAuthClient()] });

/**
 * Resolve a same-origin redirect target from the callbackUrl query param.
 * Accepts only absolute paths ('/foo'); rejects protocol-relative ('//evil')
 * and absolute URLs ('https://evil'). Mirrors the prior placeholder's guard.
 */
function safeCallback(): string {
  if (typeof window === 'undefined') return '/activity';
  const raw = new URLSearchParams(window.location.search).get('callbackUrl');
  return raw && raw.charAt(0) === '/' && raw.charAt(1) !== '/' ? raw : '/activity';
}

export function LoginForm({
  hasOidc,
  passwordLoginEnabled,
}: {
  hasOidc: boolean;
  passwordLoginEnabled: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ssoRedirecting, setSsoRedirecting] = useState(false);

  // Show the password form unless OIDC-only mode is in effect.
  const showPasswordForm = passwordLoginEnabled;

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, rememberMe }),
      });
      if (res.ok) {
        window.location.href = safeCallback();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(
        body.message ??
          "Check your email and password. The pair didn't match a known account.",
      );
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSso() {
    setError(null);
    setSsoRedirecting(true);
    try {
      const { error: ssoError } = await authClient.signIn.oauth2({
        providerId: 'oidc',
        callbackURL: safeCallback(),
      });
      if (ssoError) {
        setSsoRedirecting(false);
        setError(ssoError.message ?? 'Could not start the SSO sign-in flow.');
      }
      // On success the call performs a full-page redirect to the IdP.
    } catch {
      setSsoRedirecting(false);
      setError('Could not start the SSO sign-in flow.');
    }
  }

  return (
    <div className="flex w-[420px] flex-col gap-[22px]">
      {/* Hero. */}
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Sign in
        </div>
        <h1 className="mt-1.5 font-serif text-[42px] font-normal italic leading-[1.05] tracking-[-0.8px] text-fg">
          Welcome back.
        </h1>
        <div className="mt-2.5 font-sans text-[13.5px] leading-[1.5] text-fg-muted">
          Sign in to your keep.
        </div>
      </div>

      {/* Card. */}
      <div className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface p-6 shadow-md">
        {/* Inline error banner — danger tone. */}
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2.5 rounded-sm border border-danger bg-danger-bg px-3 py-2.5 font-sans text-[12.5px] leading-[1.45] text-danger"
          >
            <span aria-hidden="true" className="mt-px text-[14px] leading-none">
              ✕
            </span>
            <span>{error}</span>
          </div>
        )}

        {/* SSO first — it's the org-blessed path. */}
        {hasOidc && (
          <GhostButton
            label={ssoRedirecting ? 'Redirecting…' : 'Continue with SSO'}
            disabled={ssoRedirecting}
            onClick={handleSso}
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 1.5C5 1.5 3 3.5 3 6.5v1.2C2 8 1.5 8.7 1.5 9.5v3c0 1.1.9 2 2 2h9c1.1 0 2-.9 2-2v-3c0-.8-.5-1.5-1.5-1.8V6.5c0-3-2-5-5-5z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
                <circle cx="8" cy="11" r="1.2" fill="currentColor" />
              </svg>
            }
          />
        )}

        {/* Divider — only when both SSO and password are available. */}
        {hasOidc && showPasswordForm && (
          <div className="flex items-center gap-2.5">
            <div className="h-px flex-1 bg-hairline" />
            <span className="font-mono text-[10px] uppercase tracking-[1.4px] text-fg-faint">
              or with password
            </span>
            <div className="h-px flex-1 bg-hairline" />
          </div>
        )}

        {/* Password form. */}
        {showPasswordForm && (
          <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
            <Field
              id="email"
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus
              required
            />
            <Field
              id="password"
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              mono
              suffix={
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-pressed={showPassword}
                  className="shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.8px] text-fg-faint hover:text-fg-muted"
                >
                  {showPassword ? 'hide' : 'show'}
                </button>
              }
            />

            <div className="flex items-center justify-between">
              <label className="inline-flex cursor-pointer items-center gap-2 font-sans text-[12px] text-fg-muted">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="h-3.5 w-3.5 rounded-sm border border-hairline-strong bg-surface-2 accent-accent"
                />
                Keep me signed in
              </label>
            </div>

            <PrimaryButton label="Sign in →" loading={submitting} />
          </form>
        )}

        {/* OIDC-only mode: no password form. A muted caption rather than a
            dead link (no self-service recovery exists). */}
        {!showPasswordForm && (
          <div className="font-sans text-[12px] leading-[1.5] text-fg-faint">
            Password sign-in is disabled on this instance. Use single sign-on above.
          </div>
        )}
      </div>

      {/* First-run hint. */}
      <div className="text-center font-sans text-[12px] text-fg-faint">
        New install?{' '}
        <Link href="/setup" className="text-accent no-underline hover:underline">
          Set up your keep →
        </Link>
      </div>
    </div>
  );
}
