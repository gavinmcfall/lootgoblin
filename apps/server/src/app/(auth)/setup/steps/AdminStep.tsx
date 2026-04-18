'use client';
import { useState } from 'react';
import { signIn } from 'next-auth/react';

export function AdminStep({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const res = await fetch('/api/setup', { method: 'POST', body: form });
    if (res.ok) {
      // Auto-sign-in so subsequent API calls (library, pair) have a session
      const signInRes = await signIn('credentials', {
        username: String(form.get('username')),
        password: String(form.get('password')),
        redirect: false,
      });
      if (signInRes?.ok) onDone();
      else setError('User created but sign-in failed. Try signing in manually.');
    } else {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? 'Setup failed');
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-100">Create admin user</h2>
      <p className="text-sm text-slate-400">Pick a username and password (≥ 12 chars). You can change them later.</p>
      <form onSubmit={onSubmit} className="space-y-3">
        <input name="username" placeholder="Username" required className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-slate-100" />
        <input name="password" type="password" placeholder="Password (min 12 chars)" required minLength={12} className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-slate-100" />
        <button type="submit" className="rounded bg-emerald-600 px-4 py-2 w-full text-sm font-medium text-emerald-50 hover:bg-emerald-500">
          Create admin
        </button>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </form>
    </div>
  );
}
