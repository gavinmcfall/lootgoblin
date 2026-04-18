'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface Destination {
  id: string;
  name: string;
  config: { path: string; namingTemplate: string };
}

export function BulkAssignDialog({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [destId, setDestId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    fetch('/api/v1/destinations')
      .then((r) => r.json())
      .then((d: { destinations: Destination[] }) => setDestinations(d.destinations));
  }, []);

  async function apply() {
    if (!destId) return;
    setSubmitting(true);
    try {
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`/api/v1/queue/${id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ destinationId: destId }),
          }),
        ),
      );
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        toast.error(`${failed} of ${ids.length} failed`);
      } else {
        toast.success(`Assigned ${ids.length} item${ids.length === 1 ? '' : 's'}`);
      }
      qc.invalidateQueries({ queryKey: ['items'] });
      onDone();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-slate-100">
          Assign library to {ids.length} item{ids.length === 1 ? '' : 's'}
        </h2>

        <div className="mt-4 space-y-2">
          {!destinations ? (
            <p className="text-sm text-slate-400">Loading libraries…</p>
          ) : destinations.length === 0 ? (
            <p className="text-sm text-slate-400">
              No libraries configured.{' '}
              <a href="/libraries/new" className="text-sky-300 underline">
                Create one
              </a>
              .
            </p>
          ) : (
            destinations.map((d) => (
              <label
                key={d.id}
                className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${
                  destId === d.id
                    ? 'border-emerald-600 bg-emerald-500/10'
                    : 'border-slate-700 hover:border-slate-600'
                }`}
              >
                <input
                  type="radio"
                  name="dest"
                  value={d.id}
                  checked={destId === d.id}
                  onChange={() => setDestId(d.id)}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium text-slate-100">{d.name}</div>
                  <div className="font-mono text-xs text-slate-400">
                    {d.config.path} · {d.config.namingTemplate}
                  </div>
                </div>
              </label>
            ))
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={!destId || submitting}
            className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Assigning…' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  );
}
