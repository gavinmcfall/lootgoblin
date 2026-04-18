'use client';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DestinationForm, type DestinationFormValues } from '@/components/libraries/DestinationForm';

export default function NewLibraryPage() {
  const router = useRouter();
  async function onSubmit(values: DestinationFormValues) {
    const res = await fetch('/api/v1/destinations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: values.name,
        type: 'filesystem',
        config: { path: values.path, namingTemplate: values.namingTemplate },
        packager: values.packager,
        credentialId: values.credentialId,
      }),
    });
    if (!res.ok) {
      toast.error('Failed to create library');
      return;
    }
    toast.success('Library created');
    router.push('/libraries');
    router.refresh();
  }
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-slate-100">New library</h2>
      <DestinationForm onSubmit={onSubmit} submitLabel="Create" />
    </div>
  );
}
