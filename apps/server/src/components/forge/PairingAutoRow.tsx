// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Auto-paired row — high confidence (≥0.85). Compact grid row.

import { InboxKindIcon } from './InboxKindIcon';
import { ConfidenceBar } from './ConfidenceBar';
import { MetaBadge } from '@/components/shell/atoms';

interface PairingAutoRowProps {
  filename: string;
  targetPath: string | null;
  confidence: number;
  kind: string;
  source: string | null;
}

export function PairingAutoRow({
  filename,
  targetPath,
  confidence,
  kind,
  source,
}: PairingAutoRowProps) {
  return (
    <div className="grid items-center gap-3.5 rounded border border-hairline bg-surface px-3.5 py-2.5"
      style={{ gridTemplateColumns: '26px 1fr auto 100px 80px' }}>
      {/* kind icon */}
      <div className="flex justify-center">
        <InboxKindIcon kind={kind} size={20} />
      </div>

      {/* filename + proposed path */}
      <div>
        <div className="font-mono text-[11.5px] font-medium text-fg">{filename}</div>
        <div className="mt-0.5 font-mono text-[10px] text-fg-faint">
          → <span className="text-fg-muted">{targetPath ?? '—'}</span>
        </div>
      </div>

      {/* confidence bar */}
      <ConfidenceBar confidence={confidence} width={60} />

      {/* source */}
      <div className="font-mono text-[10px] text-fg-faint">{source ?? '—'}</div>

      {/* state badge */}
      <div className="text-right">
        <MetaBadge tone="success">auto</MetaBadge>
      </div>
    </div>
  );
}
