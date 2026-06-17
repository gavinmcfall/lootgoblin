// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// /forge/inboxes/new — Create a new inbox watch folder.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { SectionTitle, Tile } from '@/components/shell/atoms';
import { InboxForm, type InboxFormValues } from '@/components/forge/InboxForm';

export default function NewInboxPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | undefined>(undefined);

  async function onSubmit(values: InboxFormValues) {
    setServerError(undefined);
    const res = await fetch('/api/v1/forge/inboxes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: values.name,
        path: values.path,
        defaultPrinterId: values.defaultPrinterId || undefined,
        notes: values.notes || undefined,
      }),
    });
    if (!res.ok) {
      toast.error('Failed to create inbox');
      setServerError('Failed to create inbox. Check the path and try again.');
      return;
    }
    toast.success('Inbox created');
    router.push('/forge/inboxes');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <SectionTitle>New inbox</SectionTitle>
      <Tile className="p-6 max-w-2xl">
        <InboxForm onSubmit={onSubmit} submitLabel="Create" serverError={serverError} />
      </Tile>
    </div>
  );
}
