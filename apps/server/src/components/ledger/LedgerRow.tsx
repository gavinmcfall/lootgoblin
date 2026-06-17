// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';

import Link from 'next/link';

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
 * One ledger row, rendered as a semantic <tr> with grid layout so screen
 * readers announce "row, 5 columns" with proper column headers. Navigation
 * is owned by a real <Link> anchored in the When cell — that gives us
 * keyboard activation, middle-click "open in new tab", and cmd/ctrl-click
 * "open in background" for free, all via browser defaults. No row-level
 * click or key handlers; the `cursor-pointer` hint is purely visual.
 */
export function LedgerRow({ event }: Props) {
  const at = new Date(event.ingestedAt);
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;
  const tone = toneForKind(event.kind);
  const preview = payloadPreview(event.payload);
  const href = `/ledger/${event.id}`;
  const whenLabel = relativeAge(occurredAt ?? at);
  const whenTitle = (occurredAt ?? at).toLocaleString();

  return (
    <tr
      className={`${LEDGER_GRID_COLS} relative cursor-pointer border-b border-dashed border-hairline px-2 py-2.5 transition-colors hover:bg-surface-2 focus-within:bg-surface-2`}
    >
      {/* When — owns the navigation anchor. The anchor's `::after` pseudo-
          element stretches across the whole <tr> so clicks anywhere in the row
          reach this link, while keyboard focus and the focus ring stay on the
          anchor itself (single tab stop). The Subject id's `title` tooltip is
          a sibling span on the anchor's own stacking layer, so it still works
          where its cell sits. */}
      <td className="font-mono text-[10.5px] uppercase tracking-[1px] text-fg-faint">
        <Link
          href={href}
          title={whenTitle}
          className="rounded-sm text-fg-faint hover:text-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent after:absolute after:inset-0 after:content-['']"
        >
          {whenLabel}
        </Link>
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
