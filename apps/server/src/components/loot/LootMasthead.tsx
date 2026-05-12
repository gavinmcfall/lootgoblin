'use client';
// LootMasthead — large serif title + thumbnail + KV field-book strip.
// Canvas ref: BoldDetailMasthead (page-detail-bold.jsx line 41–91).

import Link from 'next/link';
import { useState } from 'react';
import { MetaBadge, KV } from '@/components/shell/atoms';
import { relativeAge } from '@/lib/time';
import { formatBytes } from './loot-utils';

interface LootFile {
  id: string;
  kind: string;
  relativePath: string;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string;
}

interface LootMastheadProps {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  creator: string | null;
  license: string | null;
  createdAt: string;
  fileMissing: boolean;
  parentLootId: string | null;
  files: LootFile[];
}

export function LootMasthead({
  id,
  title,
  description,
  tags,
  creator,
  license,
  createdAt,
  fileMissing,
  parentLootId,
  files,
}: LootMastheadProps) {
  const [thumbError, setThumbError] = useState(false);
  const idSuffix = id.replace(/-/g, '').toUpperCase().slice(-4);
  const totalBytes = files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);

  return (
    <div className="mb-8">
      {/* Catalogue stripe */}
      <div className="mb-3 flex items-baseline gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Nº {idSuffix} · Catalogue
        </span>
        <span className="flex-1 border-b border-dashed border-hairline" />
        <span className="font-mono text-[10px] text-fg-faint">
          {files.length} file{files.length !== 1 ? 's' : ''} · {formatBytes(totalBytes)}
        </span>
      </div>

      {/* Title */}
      <h1 className="mb-2 font-serif text-[52px] font-normal leading-none tracking-[-1.5px] text-fg" style={{ maxWidth: 920 }}>
        {title}
      </h1>

      {/* Status badges */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {fileMissing && <MetaBadge tone="danger">missing</MetaBadge>}
        {parentLootId && (
          <Link href={`/loot/${parentLootId}`} className="no-underline">
            <MetaBadge tone="neutral">
              sliced from{' '}
              <span className="font-mono">{parentLootId.replace(/-/g, '').toUpperCase().slice(-4)}</span>
            </MetaBadge>
          </Link>
        )}
      </div>

      {/* Description */}
      {description && description.length > 0 && (
        <p className="mb-5 max-w-[640px] font-serif text-[15px] italic leading-[1.5] text-fg-muted">
          {description}
        </p>
      )}

      {/* Thumbnail + field book */}
      <div className="grid grid-cols-[1.4fr_1fr] gap-9">
        {/* Hero thumbnail */}
        <div>
          <div className="relative mb-3 overflow-hidden rounded-lg border border-hairline bg-surface-2" style={{ height: 360 }}>
            {thumbError ? (
              <div className="flex h-full items-center justify-center font-serif text-[13px] italic text-fg-faint">
                No thumbnail.
              </div>
            ) : (
              <img
                src={`/api/v1/loot/${id}/thumbnail`}
                alt={title}
                loading="lazy"
                onError={() => setThumbError(true)}
                className="block h-full w-full object-cover"
              />
            )}
            {/* Nº overlay */}
            <div
              className="pointer-events-none absolute right-4 top-4 font-serif leading-none text-white/30"
              style={{ fontSize: 64, letterSpacing: -2, textShadow: '0 2px 8px rgba(0,0,0,0.5)' }}
            >
              Nº <span className="font-mono text-[32px]">{idSuffix}</span>
            </div>
          </div>
        </div>

        {/* Field book */}
        <div>
          <div className="mb-3 flex items-baseline gap-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-fg-faint">Field book</span>
            <span className="flex-1 border-b border-dashed border-hairline" />
          </div>
          <dl>
            {creator && <KV k="Creator" v={creator} />}
            {license && <KV k="Licence" v={license} />}
            {tags.length > 0 && <KV k="Tags" v={tags.map((t) => `#${t}`).join('  ')} />}
            <KV k="Looted" v={`${relativeAge(new Date(createdAt))} ago`} />
            <KV k="Files" v={`${files.length} file${files.length !== 1 ? 's' : ''} · ${formatBytes(totalBytes)}`} />
          </dl>
        </div>
      </div>
    </div>
  );
}
