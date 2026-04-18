'use client';
import { useState } from 'react';

export default function SetupPage() {
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const res = await fetch('/api/setup', { method: 'POST', body: form });
    if (res.ok) window.location.href = '/login';
    else setError((await res.json()).error ?? 'Setup failed');
  }

  return (
    <main className="mx-auto mt-20 max-w-md p-8 space-y-4">
      <h1 className="text-xl font-semibold">Welcome to LootGoblin — create admin</h1>
      <form onSubmit={onSubmit} className="space-y-3">
        <input name="username" placeholder="Username" required className="w-full rounded border border-slate-700 bg-slate-900 p-2" />
        <input name="password" type="password" placeholder="Password (min 12 chars)" required className="w-full rounded border border-slate-700 bg-slate-900 p-2" />
        <button type="submit" className="rounded bg-emerald-600 px-4 py-2 w-full">Create admin</button>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </form>
    </main>
  );
}
