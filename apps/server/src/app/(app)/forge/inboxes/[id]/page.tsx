'use client';
// /forge/inboxes/[id] — Edit an existing inbox watch folder.

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EmptyHint, SectionTitle, Tile } from '@/components/shell/atoms';
import { InboxForm, type InboxFormValues } from '@/components/forge/InboxForm';

interface ForgeInboxDto {
  id: string;
  ownerId: string;
  name: string;
  path: string;
  defaultPrinterId: string | null;
  active: boolean;
  notes: string | null;
  createdAt: number;
}

export default function EditInboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [serverError, setServerError] = useState<string | undefined>(undefined);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['forge', 'inbox', id],
    queryFn: async (): Promise<{ inbox: ForgeInboxDto }> => {
      const res = await fetch(`/api/v1/forge/inboxes/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ inbox: ForgeInboxDto }>;
    },
    staleTime: 5_000,
  });

  if (isError) return <EmptyHint>Failed to load inbox.</EmptyHint>;
  if (isLoading || !data) return <EmptyHint>Loading inbox…</EmptyHint>;

  const inbox = data.inbox;

  async function onSubmit(values: InboxFormValues) {
    setServerError(undefined);
    const res = await fetch(`/api/v1/forge/inboxes/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: values.name,
        path: values.path,
        defaultPrinterId: values.defaultPrinterId || null,
        active: values.active,
        notes: values.notes || null,
      }),
    });
    if (!res.ok) {
      toast.error('Save failed');
      setServerError('Save failed. Please try again.');
      return;
    }
    toast.success('Inbox updated');
    router.push('/forge/inboxes');
    router.refresh();
  }

  async function onDelete() {
    if (!confirm(`Delete inbox "${inbox.name}"? This will also stop the file watcher.`)) return;
    const res = await fetch(`/api/v1/forge/inboxes/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Delete failed');
      return;
    }
    toast.success('Inbox deleted');
    router.push('/forge/inboxes');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <SectionTitle>Edit inbox</SectionTitle>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md border border-danger bg-danger-bg px-3 py-1.5 font-sans text-[12.5px] font-semibold text-danger hover:bg-danger hover:text-bg transition-colors"
        >
          Delete
        </button>
      </div>
      <Tile className="p-6 max-w-2xl">
        <InboxForm
          onSubmit={onSubmit}
          defaults={{
            name: inbox.name,
            path: inbox.path,
            defaultPrinterId: inbox.defaultPrinterId ?? '',
            active: inbox.active,
            notes: inbox.notes ?? '',
          }}
          submitLabel="Save"
          serverError={serverError}
        />
      </Tile>
    </div>
  );
}
