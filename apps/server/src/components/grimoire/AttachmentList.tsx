'use client';
// AttachmentList — list of Loot items a grimoire profile/setting is attached to.
// Fetches /api/v1/loot/[id]/grimoire-attachments in reverse: we can't query
// "all loot for this profile" from that endpoint directly, so this component
// accepts a pre-fetched list of attachments (passed from the detail page).
// Canvas reference: GrimoireDetail "Used in 4 prints" sidebar (page-grimoire.jsx line 256–272).

import Link from 'next/link';
import { EmptyHint } from '@/components/shell/atoms';
import { relativeAge } from '@/lib/time';

interface AttachmentDto {
  id: string;
  lootId: string;
  note: string | null;
  attachedAt: string;
}

interface AttachmentListProps {
  attachments: AttachmentDto[];
  isLoading?: boolean;
  isError?: boolean;
}

export function AttachmentList({ attachments, isLoading, isError }: AttachmentListProps) {
  if (isError) return <EmptyHint>Failed to load attachments.</EmptyHint>;
  if (isLoading) return <EmptyHint>Loading attachments…</EmptyHint>;
  if (attachments.length === 0) {
    return <EmptyHint>Not attached to any Loot yet.</EmptyHint>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
      {attachments.map((a, idx) => {
        const isLast = idx === attachments.length - 1;
        return (
          <div
            key={a.id}
            className={`flex items-baseline gap-3 px-[14px] py-[10px] text-[12px] ${
              isLast ? '' : 'border-b border-dashed border-hairline'
            }`}
          >
            <Link
              href={`/hoard/loot/${a.lootId}`}
              className="font-mono text-[10.5px] text-accent underline-offset-2 hover:underline"
            >
              {a.lootId.slice(0, 8)}…
            </Link>
            {a.note && (
              <span className="flex-1 font-serif text-[12.5px] italic text-fg-muted">
                {a.note}
              </span>
            )}
            <span className="ml-auto font-serif text-[12px] italic text-fg-faint">
              {relativeAge(new Date(a.attachedAt))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
