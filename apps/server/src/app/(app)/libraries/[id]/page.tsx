'use client';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { use } from 'react';
import { DestinationForm, type DestinationFormValues } from '@/components/libraries/DestinationForm';

interface Destination {
  id: string;
  name: string;
  config: { path: string; namingTemplate: string };
  packager: string;
  credentialId?: string;
}

export default function EditLibraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ['destination', id],
    queryFn: async (): Promise<{ destination: Destination }> =>
      (await fetch(`/api/v1/destinations/${id}`)).json(),
  });

  async function onSubmit(values: DestinationFormValues) {
    const res = await fetch(`/api/v1/destinations/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: values.name,
        config: { path: values.path, namingTemplate: values.namingTemplate },
        packager: values.packager,
        credentialId: values.credentialId,
      }),
    });
    if (!res.ok) {
      toast.error('Save failed');
      return;
    }
    toast.success('Saved');
    router.push('/libraries');
    router.refresh();
  }

  async function onDelete() {
    if (!confirm('Delete this library?')) return;
    const res = await fetch(`/api/v1/destinations/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Delete failed');
      return;
    }
    toast.success('Deleted');
    router.push('/libraries');
    router.refresh();
  }

  if (isLoading || !data) return <p className="text-sm text-slate-400">Loading…</p>;
  const d = data.destination;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-100">Edit library</h2>
        <button onClick={onDelete} className="rounded border border-red-700 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/40">Delete</button>
      </div>
      <DestinationForm
        onSubmit={onSubmit}
        defaults={{
          name: d.name,
          path: d.config.path,
          namingTemplate: d.config.namingTemplate,
          packager: d.packager as 'manyfold-v0',
          credentialId: d.credentialId,
        }}
        submitLabel="Save"
      />
    </div>
  );
}
