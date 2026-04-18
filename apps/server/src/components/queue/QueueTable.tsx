'use client';
import type { Item } from '@/hooks/useItems';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

export function QueueTable({
  items,
  selected,
  onSelected,
}: {
  items: Item[];
  selected: string[];
  onSelected: (ids: string[]) => void;
}) {
  const qc = useQueryClient();
  const allSelected = items.length > 0 && selected.length === items.length;

  function toggleAll() {
    onSelected(allSelected ? [] : items.map((i) => i.id));
  }
  function toggleOne(id: string) {
    onSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  async function remove(id: string) {
    if (!confirm('Remove this item from the queue?')) return;
    const res = await fetch(`/api/v1/queue/${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.success('Removed');
      qc.invalidateQueries({ queryKey: ['items'] });
    } else {
      toast.error('Remove failed');
    }
  }

  if (items.length === 0) {
    return <p className="text-sm text-slate-500">Queue is empty.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="w-10 px-3 py-2 text-left">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            </th>
            <th className="px-3 py-2 text-left font-medium">Title</th>
            <th className="px-3 py-2 text-left font-medium">Source</th>
            <th className="px-3 py-2 text-left font-medium">Destination</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="w-24 px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const snap = (i.snapshot ?? {}) as Record<string, unknown>;
            const title = (snap.title as string | undefined) ?? `${i.sourceId}:${i.sourceItemId}`;
            return (
              <tr key={i.id} className="border-t border-slate-800 hover:bg-slate-900/60">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(i.id)}
                    onChange={() => toggleOne(i.id)}
                  />
                </td>
                <td className="max-w-sm truncate px-3 py-2 text-slate-100">{title}</td>
                <td className="px-3 py-2 text-slate-400">{i.sourceId}</td>
                <td className="px-3 py-2 text-slate-400">
                  {i.destinationId ? (
                    <span className="text-emerald-300">assigned</span>
                  ) : (
                    <span className="italic">unassigned</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-400">{i.status}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => remove(i.id)}
                    className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-red-600 hover:text-red-300"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
