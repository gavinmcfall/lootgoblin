'use client';
// /ledger/[id] — single ledger event detail.
//
// Honest event-stream detail view. Drops the receipts/money framing of the
// design entirely (page-receipts.jsx is fiction wrt the backend) and surfaces
// the fields the API actually returns: kind, subject, actor, provenance,
// timestamps, related resources, and the raw payload JSON.

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

import { EmptyHint, KV, MetaBadge, SectionTitle } from '@/components/shell/atoms';
import { toneForKind } from '@/components/ledger/kind-tone';
import { subjectHref } from '@/components/ledger/subject-link';
import type { LedgerEventDto } from '@/components/ledger/types';

async function fetchEvent(id: string): Promise<LedgerEventDto> {
  const res = await fetch(`/api/v1/ledger/${encodeURIComponent(id)}`);
  if (res.status === 404) {
    const err = new Error('not-found');
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function SubjectValue({ subjectType, subjectId }: { subjectType: string; subjectId: string }) {
  const href = subjectHref(subjectType, subjectId);
  const inner = (
    <>
      <span className="text-fg-muted">{subjectType}</span>
      <span className="mx-1 text-fg-ghost">·</span>
      <span className="text-fg">{subjectId}</span>
    </>
  );
  if (!href) return <span className="break-all">{inner}</span>;
  return (
    <Link href={href} className="break-all text-accent hover:underline">
      {inner}
    </Link>
  );
}

export default function LedgerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['ledger', 'event', id],
    queryFn: () => fetchEvent(id),
    staleTime: 30_000,
    retry: (count, err) => {
      // Don't retry hide-existence 404s.
      const status = (err as Error & { status?: number }).status;
      if (status === 404) return false;
      return count < 2;
    },
  });

  if (isError) {
    const status = (error as Error & { status?: number } | undefined)?.status;
    return (
      <div className="space-y-4">
        <EmptyHint>
          {status === 404
            ? 'This event could not be found. It may not exist, or you may not have permission to see it.'
            : 'Failed to load this ledger event.'}
        </EmptyHint>
        <Link
          href="/ledger"
          className="font-mono text-[11px] uppercase tracking-[1px] text-accent hover:underline"
        >
          ← Back to ledger
        </Link>
      </div>
    );
  }

  if (isLoading || !data) {
    return <EmptyHint>Loading…</EmptyHint>;
  }

  const tone = toneForKind(data.kind);
  const payloadJson =
    data.payload === null
      ? '—'
      : (() => {
          try {
            return JSON.stringify(data.payload, null, 2);
          } catch {
            return String(data.payload);
          }
        })();

  return (
    <div className="flex flex-col gap-7">
      {/* Masthead */}
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <Link
            href="/ledger"
            className="font-mono text-[10px] uppercase tracking-[1.6px] text-fg-faint hover:text-accent"
          >
            ledger
          </Link>
          <span className="font-mono text-[10px] text-fg-ghost">/</span>
          <span className="font-mono text-[10px] uppercase tracking-[1.6px] text-fg-muted">
            event
          </span>
          <div className="flex-1 border-b border-dashed border-hairline" />
          <span className="font-mono text-[10px] text-fg-muted" title={data.id}>
            #{data.id.slice(0, 8)}
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <h1 className="m-0 font-serif text-[36px] font-normal leading-[1.05] tracking-[-0.9px] text-fg">
            <span className="italic">{data.kind}</span>
          </h1>
          <MetaBadge tone={tone}>{tone}</MetaBadge>
        </div>
        <p className="m-0 max-w-[680px] font-serif text-[13.5px] italic text-fg-muted">
          Ingested {formatTimestamp(data.ingestedAt)}
          {data.occurredAt && data.occurredAt !== data.ingestedAt && (
            <> · occurred {formatTimestamp(data.occurredAt)}</>
          )}
          .
        </p>
      </header>

      {/* Facts */}
      <section>
        <SectionTitle meta="event facts">Facts</SectionTitle>
        <dl className="rounded-md border border-hairline bg-surface p-4">
          <KV k="id" v={data.id} mono />
          <KV k="kind" v={data.kind} mono />
          <KV
            k="subject"
            v={<SubjectValue subjectType={data.subjectType} subjectId={data.subjectId} />}
            mono
          />
          <KV
            k="actor"
            v={data.actorUserId ?? <span className="text-fg-faint">— (system)</span>}
            mono
          />
          <KV
            k="provenance"
            v={data.provenanceClass ?? <span className="text-fg-faint">—</span>}
            mono
          />
          <KV k="occurred at" v={formatTimestamp(data.occurredAt)} mono />
          <KV k="ingested at" v={formatTimestamp(data.ingestedAt)} mono />
        </dl>
      </section>

      {/* Related resources */}
      {data.relatedResources && data.relatedResources.length > 0 && (
        <section>
          <SectionTitle meta={`${data.relatedResources.length}`}>Related</SectionTitle>
          <ul className="rounded-md border border-hairline bg-surface">
            {data.relatedResources.map((r, i) => {
              const href = subjectHref(r.kind, r.id);
              const label = (
                <span className="break-all">
                  <span className="text-fg-muted">{r.kind}</span>
                  <span className="mx-1 text-fg-ghost">·</span>
                  <span className="text-fg">{r.id}</span>
                </span>
              );
              return (
                <li
                  key={`${r.kind}:${r.id}:${i}`}
                  className="flex items-baseline gap-3 border-b border-dashed border-hairline px-4 py-2 last:border-b-0"
                >
                  <span className="min-w-[80px] font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">
                    {r.role}
                  </span>
                  <span className="flex-1 font-mono text-[12px]">
                    {href ? (
                      <Link href={href} className="text-accent hover:underline">
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Payload */}
      <section>
        <SectionTitle meta="raw json">Payload</SectionTitle>
        <pre className="m-0 max-h-[480px] overflow-auto rounded-md border border-hairline bg-surface-2 p-4 font-mono text-[11.5px] leading-[1.55] text-fg">
          {payloadJson}
        </pre>
      </section>

      <div>
        <Link
          href="/ledger"
          className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint hover:text-accent"
        >
          ← Back to ledger
        </Link>
      </div>
    </div>
  );
}
