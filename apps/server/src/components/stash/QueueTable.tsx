// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
import type { Item } from '@/hooks/useItems';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { MetaBadge, Tile } from '@/components/shell/atoms';
import { relativeAge } from '@/lib/time';

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
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selected.length > 0 && selected.length < items.length;
    }
  }, [selected, items]);

  function toggleAll() {
    onSelected(allSelected ? [] : items.map((i) => i.id));
  }
  function toggleOne(id: string) {
    onSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  async function remove(id: string) {
    if (!confirm('Remove this item from the queue?')) return;
    const res = await fetch(`/api/v1/stash/${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.success('Removed');
      qc.invalidateQueries({ queryKey: ['items'] });
    } else {
      toast.error('Remove failed');
    }
  }

  return (
    <Tile>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-hairline-strong">
            <th className="w-10 px-3 py-2.5 text-left">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="Select all"
              />
            </th>
            <th className="w-16 px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint">
              Landed
            </th>
            <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint">
              Item
            </th>
            <th className="w-32 px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint">
              Source
            </th>
            <th className="w-32 px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint">
              Destination
            </th>
            <th className="w-20 px-3 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {items.map((i, idx) => {
            const snap = (i.snapshot ?? {}) as Record<string, unknown>;
            const title = (snap.title as string | undefined) ?? `${i.sourceId}:${i.sourceItemId}`;
            const isLast = idx === items.length - 1;
            const isSelected = selected.includes(i.id);
            return (
              <tr
                key={i.id}
                className={`border-b border-hairline hover:bg-surface-hi ${isLast ? 'border-b-0' : ''} ${isSelected ? 'bg-accent-soft' : ''}`}
              >
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleOne(i.id)}
                    aria-label={`Select ${title}`}
                  />
                </td>
                <td className="px-3 py-2.5">
                  <span className="font-serif text-[15px] italic leading-none tracking-[-0.3px] text-fg-muted">
                    {relativeAge(new Date(i.createdAt))}
                  </span>
                </td>
                <td className="max-w-sm truncate px-3 py-2.5 text-[13.5px] font-medium text-fg">
                  {title}
                </td>
                <td className="px-3 py-2.5">
                  <MetaBadge tone="neutral">{i.sourceId}</MetaBadge>
                </td>
                <td className="px-3 py-2.5 font-mono text-[10.5px] text-fg-muted">
                  {i.hoardId ? (
                    <span className="text-fg">assigned</span>
                  ) : (
                    <span className="italic text-fg-faint">unassigned</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    onClick={() => remove(i.id)}
                    className="rounded-sm border border-hairline px-2 py-1 font-mono text-[10.5px] text-fg-muted transition-colors hover:border-danger hover:text-danger"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Tile>
  );
}
