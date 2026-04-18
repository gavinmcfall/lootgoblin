'use client';
import { useItems } from '@/hooks/useItems';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

export default function HistoryPage() {
  const { data, isLoading } = useItems();
  const qc = useQueryClient();
  const items = (data?.items ?? []).filter((i) =>
    i.status === 'done' || i.status === 'failed' || i.status === 'skipped',
  );

  async function retry(id: string, sourceId: string, sourceItemId: string, sourceUrl: string) {
    // Re-enqueue with force=true to bypass dedup
    const res = await fetch('/api/v1/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId,
        sourceItemId,
        sourceUrl,
        contentType: 'model-3d',
        force: true,
      }),
    });
    if (res.ok) {
      toast.success('Re-queued');
      qc.invalidateQueries({ queryKey: ['items'] });
    } else {
      toast.error('Retry failed');
    }
  }

  function copyPath(path: string) {
    navigator.clipboard.writeText(path);
    toast.success('Path copied');
  }

  if (isLoading) return <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-100">History</h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing here yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Title</th>
                <th className="px-3 py-2 text-left font-medium">Source</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Completed</th>
                <th className="px-3 py-2 text-left font-medium">Output</th>
                <th className="w-40 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const snap = (i.snapshot ?? {}) as Record<string, unknown>;
                const title = (snap.title as string | undefined) ?? `${i.sourceId}:${i.sourceItemId}`;
                return (
                  <tr key={i.id} className="border-t border-slate-800">
                    <td className="max-w-xs truncate px-3 py-2 text-slate-100">{title}</td>
                    <td className="px-3 py-2 text-slate-400">{i.sourceId}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          i.status === 'done'
                            ? 'text-emerald-300'
                            : i.status === 'failed'
                            ? 'text-red-300'
                            : 'text-slate-400'
                        }
                      >
                        {i.status}
                      </span>
                      {i.lastError && (
                        <span className="ml-2 text-xs text-slate-500">· {i.lastError.slice(0, 40)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {i.completedAt ? new Date(i.completedAt).toLocaleString() : '—'}
                    </td>
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-slate-400">
                      {i.outputPath ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {i.status === 'failed' ? (
                        <button
                          onClick={() => retry(i.id, i.sourceId, i.sourceItemId, i.sourceUrl)}
                          className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-emerald-600 hover:text-emerald-300"
                        >
                          Retry
                        </button>
                      ) : i.status === 'done' && i.outputPath ? (
                        <button
                          onClick={() => copyPath(i.outputPath!)}
                          className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-sky-600 hover:text-sky-300"
                        >
                          Copy path
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
