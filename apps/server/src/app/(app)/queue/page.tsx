'use client';
import { useState } from 'react';
import { useItems } from '@/hooks/useItems';
import { QueueTable } from '@/components/queue/QueueTable';
import { BulkAssignDialog } from '@/components/queue/BulkAssignDialog';

export default function QueuePage() {
  const { data, isLoading } = useItems();
  const queued = (data?.items ?? []).filter((i) => i.status === 'queued');
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-100">Queue</h2>
        <button
          disabled={selected.length === 0}
          onClick={() => setDialog(true)}
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Assign library ({selected.length})
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <QueueTable items={queued} selected={selected} onSelected={setSelected} />
      )}

      {dialog && (
        <BulkAssignDialog
          ids={selected}
          onClose={() => setDialog(false)}
          onDone={() => {
            setDialog(false);
            setSelected([]);
          }}
        />
      )}
    </div>
  );
}
