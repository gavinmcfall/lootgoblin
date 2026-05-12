'use client';
// LootGrimoireTab — attached Grimoire profiles/settings for this Loot.
// Wires GrimoireAttachModal (canvas-port #4) into its first consumer.
// Canvas ref: BoldDetailBody right-column (page-detail-bold.jsx line 203–234).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EmptyHint, MetaBadge, SectionTitle } from '@/components/shell/atoms';
import { GrimoireAttachModal } from '@/components/grimoire/GrimoireAttachModal';
import { relativeAge } from '@/lib/time';

interface GrimoireAttachmentDto {
  id: string;
  lootId: string;
  slicerProfileId: string | null;
  printSettingId: string | null;
  note: string | null;
  ownerId: string;
  attachedAt: string;
}

interface LootGrimoireTabProps {
  lootId: string;
}

export function LootGrimoireTab({ lootId }: LootGrimoireTabProps) {
  const [showModal, setShowModal] = useState(false);
  const queryClient = useQueryClient();

  const {
    data,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['loot', lootId, 'grimoire-attachments'],
    queryFn: async (): Promise<{ attachments: GrimoireAttachmentDto[] }> => {
      const res = await fetch(`/api/v1/loot/${lootId}/grimoire-attachments`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5_000,
  });

  const { mutate: detach, isPending: detaching } = useMutation({
    mutationFn: async (attachmentId: string) => {
      const res = await fetch(`/api/v1/loot/${lootId}/grimoire-attachments/${attachmentId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      toast.success('Detached.');
      void queryClient.invalidateQueries({ queryKey: ['loot', lootId, 'grimoire-attachments'] });
    },
    onError: (err: Error) => {
      toast.error(`Failed to detach: ${err.message}`);
    },
  });

  const attachments = data?.attachments ?? [];

  return (
    <div>
      <SectionTitle
        meta={`${attachments.length} attached`}
        right={
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="rounded-md bg-accent px-3 py-1.5 font-sans text-[12px] font-semibold text-accent-ink hover:opacity-90"
          >
            Attach spell →
          </button>
        }
      >
        Grimoire
      </SectionTitle>

      {isError && <EmptyHint>Failed to load Grimoire attachments.</EmptyHint>}
      {!isError && isLoading && <EmptyHint>Loading attachments…</EmptyHint>}
      {!isError && !isLoading && attachments.length === 0 && (
        <EmptyHint>No spells attached. Hit &ldquo;Attach spell&rdquo; to link a slicer profile or print setting.</EmptyHint>
      )}
      {!isError && !isLoading && attachments.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
          {attachments.map((a, idx) => {
            const isLast = idx === attachments.length - 1;
            return (
              <div
                key={a.id}
                className={`flex items-start gap-3 px-4 py-3 ${isLast ? '' : 'border-b border-dashed border-hairline'}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <MetaBadge tone="accent">
                      {a.slicerProfileId ? 'slicer profile' : 'print setting'}
                    </MetaBadge>
                    <span className="font-mono text-[10px] text-fg-faint">
                      {(a.slicerProfileId ?? a.printSettingId ?? '').slice(0, 8)}…
                    </span>
                    <span className="ml-auto font-serif text-[12px] italic text-fg-faint">
                      {relativeAge(new Date(a.attachedAt))} ago
                    </span>
                  </div>
                  {a.note && (
                    <p className="font-serif text-[13px] italic text-fg-muted">{a.note}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => detach(a.id)}
                  disabled={detaching}
                  className="shrink-0 rounded-sm border border-hairline px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.8px] text-danger hover:bg-danger-bg disabled:opacity-40"
                >
                  Detach
                </button>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <GrimoireAttachModal lootId={lootId} onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}
