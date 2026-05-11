'use client';
import { useState } from 'react';
import { useItems } from '@/hooks/useItems';
import { QueueTable } from '@/components/stash/QueueTable';
import { BulkAssignDialog } from '@/components/stash/BulkAssignDialog';
import { SectionTitle, EmptyHint } from '@/components/shell/atoms';

export default function StashPage() {
  const { data, isLoading } = useItems();
  const queued = (data?.items ?? []).filter((i) => i.status === 'queued');
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState(false);
  return (
    <div className="space-y-6">
      <SectionTitle
        meta={`${queued.length} item${queued.length === 1 ? '' : 's'}`}
        right={
          <button
            disabled={selected.length === 0}
            onClick={() => setDialog(true)}
            className="rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-accent-ink shadow-sm transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            Sort selected ({selected.length})
          </button>
        }
      >
        In the stash
      </SectionTitle>
      {isLoading ? (
        <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>
      ) : queued.length === 0 ? (
        <EmptyHint>Nothing to sort. The goblin&apos;s shelves are tidy.</EmptyHint>
      ) : (
        <QueueTable items={queued} selected={selected} onSelected={setSelected} />
      )}
      {dialog && (
        <BulkAssignDialog
          ids={selected}
          onClose={() => {
            setDialog(false);
            setSelected([]);
          }}
        />
      )}
    </div>
  );
}
