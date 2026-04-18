'use client';
import { useState } from 'react';

export function LibraryStep({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const path = String(form.get('path') ?? '').trim();
    const namingTemplate = String(form.get('namingTemplate') ?? '{designer}/{title}').trim();
    if (!name || !path) {
      setError('Name and path are required');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/destinations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          type: 'filesystem',
          config: { path, namingTemplate },
          packager: 'manyfold-v0',
        }),
      });
      if (res.ok) onDone();
      else setError('Could not create library');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-100">Create your first library</h2>
      <p className="text-sm text-slate-400">Where should scraped items land? You can add more libraries later.</p>
      <form onSubmit={onSubmit} className="space-y-3">
        <input name="name" placeholder="Library name (e.g. 3D Models)" required className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-slate-100" />
        <input name="path" placeholder="/library/3d-models" required defaultValue="/library/3d-models" className="w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-slate-100" />
        <input name="namingTemplate" placeholder="Naming template" defaultValue="{designer}/{title}" className="w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-slate-100" />
        <div className="flex gap-2">
          <button type="submit" disabled={submitting} className="flex-1 rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500 disabled:opacity-40">
            Create library
          </button>
          <button type="button" onClick={onSkip} className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-600">
            Skip
          </button>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </form>
    </div>
  );
}
