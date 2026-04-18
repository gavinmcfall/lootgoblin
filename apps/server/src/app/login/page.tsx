'use client';
import { signIn } from 'next-auth/react';
import { useState } from 'react';

export default function LoginPage() {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await signIn('credentials', { username, password, redirect: false });
    if (res?.error) setErr('Invalid credentials'); else window.location.href = '/';
  }
  return (
    <main className="mx-auto mt-20 max-w-sm p-8 space-y-4">
      <h1 className="text-xl font-semibold">Sign in to LootGoblin</h1>
      <form onSubmit={onSubmit} className="space-y-3">
        <input value={username} onChange={(e) => setU(e.target.value)} placeholder="Username" className="w-full rounded border border-slate-700 bg-slate-900 p-2" />
        <input type="password" value={password} onChange={(e) => setP(e.target.value)} placeholder="Password" className="w-full rounded border border-slate-700 bg-slate-900 p-2" />
        <button type="submit" className="rounded bg-emerald-600 px-4 py-2 w-full">Sign in</button>
        {err && <p className="text-red-400 text-sm">{err}</p>}
      </form>
      <a href="/api/auth/signin/oidc" className="block text-center text-sm text-slate-400 hover:text-slate-200">Sign in with OIDC</a>
    </main>
  );
}
