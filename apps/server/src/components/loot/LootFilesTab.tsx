'use client';
// LootFilesTab — list of lootFiles rows with kind icon, size, path, hash.
// Canvas ref: BoldDetailBody "Contents" section (page-detail-bold.jsx line 169–199).

import { EmptyHint, SectionTitle } from '@/components/shell/atoms';
import { InboxKindIcon } from '@/components/forge/InboxKindIcon';
import { formatBytes } from './loot-utils';

interface LootFile {
  id: string;
  kind: string;
  relativePath: string;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string;
}

interface LootFilesTabProps {
  lootId: string;
  files: LootFile[];
}

/** Short basename from a relative path. */
function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

export function LootFilesTab({ lootId, files }: LootFilesTabProps) {
  if (files.length === 0) {
    return <EmptyHint>No files recorded for this Loot.</EmptyHint>;
  }

  return (
    <div>
      <SectionTitle meta={`${files.length} file${files.length !== 1 ? 's' : ''}`}>
        Contents
      </SectionTitle>

      <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
        {files.map((f, idx) => {
          const isLast = idx === files.length - 1;
          return (
            <div
              key={f.id}
              className={`grid items-center gap-3 px-4 py-3 ${isLast ? '' : 'border-b border-dashed border-hairline'}`}
              style={{ gridTemplateColumns: '28px 1fr auto auto' }}
            >
              {/* Kind icon */}
              <InboxKindIcon kind={f.kind} size={18} />

              {/* Path */}
              <div className="min-w-0">
                <div className="truncate font-serif text-[14px] leading-tight text-fg">
                  {basename(f.relativePath)}
                </div>
                {f.relativePath.includes('/') && (
                  <div className="truncate font-mono text-[10px] text-fg-faint">
                    {f.relativePath}
                  </div>
                )}
                {f.sha256 && (
                  <div className="font-mono text-[9.5px] text-fg-faint">
                    sha256: {f.sha256.slice(0, 12)}…
                  </div>
                )}
              </div>

              {/* Size */}
              <span className="whitespace-nowrap font-mono text-[11px] text-fg-muted">
                {f.sizeBytes !== null ? formatBytes(f.sizeBytes) : '—'}
              </span>

              {/* Reveal (no per-file download endpoint yet; canvas-port #14 territory) */}
              <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.8px] text-fg-faint">
                {f.kind}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
