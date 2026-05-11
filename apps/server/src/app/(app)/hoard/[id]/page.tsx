'use client';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { use, useState } from 'react';
import { DestinationForm, type DestinationFormValues } from '@/components/hoard/DestinationForm';
import { SectionTitle, Tile } from '@/components/shell/atoms';

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
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const { data, isLoading } = useQuery({
    queryKey: ['destination', id],
    queryFn: async (): Promise<{ destination: Destination }> =>
      (await fetch(`/api/v1/hoard/${id}`)).json(),
  });

  async function onSubmit(values: DestinationFormValues) {
    setServerError(undefined);
    const res = await fetch(`/api/v1/hoard/${id}`, {
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
      setServerError('Save failed. Please try again or contact support.');
      return;
    }
    toast.success('Saved');
    router.push('/hoard');
    router.refresh();
  }

  async function onDelete() {
    if (!confirm('Delete this library?')) return;
    const res = await fetch(`/api/v1/hoard/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Delete failed');
      return;
    }
    toast.success('Deleted');
    router.push('/hoard');
    router.refresh();
  }

  if (isLoading || !data) return <p className="mt-1 text-[11.5px] text-fg-faint">Loading…</p>;
  const d = data.destination;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <SectionTitle>Edit library</SectionTitle>
        <button onClick={onDelete} className="bg-danger-bg text-danger border border-danger rounded-md px-3 py-1.5 text-[12.5px] font-semibold hover:bg-danger hover:text-bg transition-colors">Delete</button>
      </div>
      <Tile className="p-6 max-w-2xl">
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
          serverError={serverError}
        />
      </Tile>
    </div>
  );
}
