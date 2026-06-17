// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { DestinationForm, type DestinationFormValues } from '@/components/hoard/DestinationForm';
import { SectionTitle, Tile } from '@/components/shell/atoms';

export default function NewLibraryPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  async function onSubmit(values: DestinationFormValues) {
    setServerError(undefined);
    const res = await fetch('/api/v1/hoard', {
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
      setServerError('Failed to create library. Please try again or contact support.');
      return;
    }
    toast.success('Library created');
    router.push('/hoard');
    router.refresh();
  }
  return (
    <div className="space-y-6">
      <SectionTitle>New library</SectionTitle>
      <Tile className="p-6 max-w-2xl">
        <DestinationForm onSubmit={onSubmit} submitLabel="Create" serverError={serverError} />
      </Tile>
    </div>
  );
}
