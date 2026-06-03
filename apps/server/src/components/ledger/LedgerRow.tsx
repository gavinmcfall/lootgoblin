'use client';

import { useRouter } from 'next/navigation';
import type { KeyboardEvent, MouseEvent } from 'react';

import { MetaBadge } from '@/components/shell/atoms';
import { relativeAge } from '@/lib/time';
import { toneForKind } from './kind-tone';
import { payloadPreview } from './payload-preview';
import { LEDGER_GRID_COLS } from './LedgerTable';
import type { LedgerEventDto } from './types';

interface Props {
  event: LedgerEventDto;
}

/** Truncate a long id (uuid etc.) to its first 8 chars. */
function shortId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(0, 8);
}

/**
 * One ledger row, rendered as a semantic <tr> with grid layout. Click / Enter /
 * Space route to the detail page. Modifier-click (ctrl/cmd/shift/meta) and
 * middle-click defer to the browser default so users can open in a new tab —
 * for that path we render the When cell's inner link as a real <a> in addition
 * to the row-level handler, so AT users still have an anchor.
 */
export function LedgerRow({ event }: Props) {
  const router = useRouter();
  const at = new Date(event.ingestedAt);
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;
  const tone = toneForKind(event.kind);
  const preview = payloadPreview(event.payload);
  const href = `/ledger/${event.id}`;

  function go() {
    router.push(href);
  }
  function onClick(e: MouseEvent<HTMLTableRowElement>) {
    // Defer to browser for modifier/middle clicks (open in new tab etc.).
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  }
  function onKeyDown(e: KeyboardEvent<HTMLTableRowElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go();
    }
  }

  return (
    <tr
      role="link"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      aria-label={`Event ${event.kind} on ${event.subjectType}`}
      className={`${LEDGER_GRID_COLS} cursor-pointer border-b border-dashed border-hairline px-2 py-2.5 transition-colors hover:bg-surface-2 focus:bg-surface-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
    >
      {/* When */}
      <td
        className="font-mono text-[10.5px] uppercase tracking-[1px] text-fg-faint"
        title={occurredAt ? occurredAt.toLocaleString() : at.toLocaleString()}
      >
        {relativeAge(occurredAt ?? at)}
      </td>

      {/* Kind */}
      <td className="flex min-w-0">
        <MetaBadge tone={tone}>{event.kind}</MetaBadge>
      </td>

      {/* Subject */}
      <td className="min-w-0 truncate text-[12.5px] text-fg">
        <span className="font-mono text-[11px] text-fg-muted">{event.subjectType}</span>
        <span className="mx-1 font-mono text-[10px] text-fg-ghost">·</span>
        <span className="font-mono text-[11px] text-fg" title={event.subjectId}>
          {shortId(event.subjectId)}
        </span>
      </td>

      {/* Actor */}
      <td
        className="truncate font-mono text-[11px] text-fg-muted"
        title={event.actorUserId ?? 'system'}
      >
        {event.actorUserId ? shortId(event.actorUserId) : '—'}
      </td>

      {/* Payload preview */}
      <td className="truncate font-mono text-[11px] text-fg-faint" title={preview}>
        {preview}
      </td>
    </tr>
  );
}
