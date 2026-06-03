'use client';

import Link from 'next/link';
import { MetaBadge } from '@/components/shell/atoms';
import { relativeAge } from '@/lib/time';
import { toneForKind } from './kind-tone';
import { payloadPreview } from './payload-preview';
import type { LedgerEventDto } from './types';

interface Props {
  event: LedgerEventDto;
}

/** Truncate a long id (uuid etc.) to its first 8 chars. */
function shortId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(0, 8);
}

export function LedgerRow({ event }: Props) {
  const at = new Date(event.ingestedAt);
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;
  const tone = toneForKind(event.kind);
  const preview = payloadPreview(event.payload);

  return (
    <Link
      href={`/ledger/${event.id}`}
      className="grid grid-cols-[80px_minmax(140px,1fr)_minmax(160px,1.2fr)_120px_minmax(160px,2fr)] items-baseline gap-3 border-b border-dashed border-hairline px-2 py-2.5 transition-colors hover:bg-surface-2"
    >
      {/* When */}
      <span
        className="font-mono text-[10.5px] uppercase tracking-[1px] text-fg-faint"
        title={occurredAt ? occurredAt.toLocaleString() : at.toLocaleString()}
      >
        {relativeAge(occurredAt ?? at)}
      </span>

      {/* Kind */}
      <span className="flex min-w-0">
        <MetaBadge tone={tone}>{event.kind}</MetaBadge>
      </span>

      {/* Subject */}
      <span className="min-w-0 truncate text-[12.5px] text-fg">
        <span className="font-mono text-[11px] text-fg-muted">{event.subjectType}</span>
        <span className="mx-1 font-mono text-[10px] text-fg-ghost">·</span>
        <span className="font-mono text-[11px] text-fg" title={event.subjectId}>
          {shortId(event.subjectId)}
        </span>
      </span>

      {/* Actor */}
      <span
        className="truncate font-mono text-[11px] text-fg-muted"
        title={event.actorUserId ?? 'system'}
      >
        {event.actorUserId ? shortId(event.actorUserId) : '—'}
      </span>

      {/* Payload preview */}
      <span
        className="truncate font-mono text-[11px] text-fg-faint"
        title={preview}
      >
        {preview}
      </span>
    </Link>
  );
}
