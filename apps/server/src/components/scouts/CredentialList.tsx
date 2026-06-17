// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Tile, MetaBadge, type Tone } from '@/components/shell/atoms';
import { ReshareHint } from './ReshareHint';

interface Credential {
  id: string;
  label: string;
  status: 'active' | 'expired' | 'revoked';
  lastUsedAt: string | null;
}

function statusTone(status: Credential['status']): Tone {
  if (status === 'active') return 'success';
  if (status === 'expired') return 'danger';
  if (status === 'revoked') return 'danger';
  return 'neutral';
}

export function CredentialList({ sourceId, authKind: _authKind }: { sourceId: string; authKind?: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['credentials', sourceId],
    queryFn: async (): Promise<{ credentials: Credential[] }> =>
      (await fetch(`/api/v1/scout-credentials/${sourceId}`)).json(),
  });

  async function remove(id: string) {
    if (!confirm('Delete this credential?')) return;
    const res = await fetch(`/api/v1/scout-credentials/${sourceId}?id=${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.success('Deleted');
      qc.invalidateQueries({ queryKey: ['credentials', sourceId] });
    } else {
      toast.error('Delete failed');
    }
  }

  if (isLoading) {
    return <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>;
  }

  const creds = data?.credentials ?? [];
  if (creds.length === 0) return <ReshareHint sourceId={sourceId} />;

  return (
    <div className="space-y-2">
      {creds.map((c) => (
        <Tile key={c.id} className="p-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[12.5px] text-fg">{c.label}</div>
              <div className="mt-1 flex items-center gap-2">
                <MetaBadge tone={statusTone(c.status)}>{c.status}</MetaBadge>
                <span className="font-mono text-[10px] text-fg-faint">
                  {c.lastUsedAt
                    ? <>last used {new Date(c.lastUsedAt).toLocaleString()}</>
                    : <>never used</>}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => remove(c.id)}
              className="rounded border border-hairline px-2 py-1 font-mono text-[10px] uppercase tracking-[0.6px] text-fg-faint hover:border-danger hover:text-danger"
            >
              Remove
            </button>
          </div>
        </Tile>
      ))}
      <p className="pt-2 font-mono text-[10px] text-fg-faint">
        To re-share, sign in to{' '}
        <span className="text-fg">{sourceId}</span>{' '}
        in your browser and click{' '}
        <span className="text-fg">Share session</span>{' '}
        in the LootGoblin extension popup.
      </p>
    </div>
  );
}
