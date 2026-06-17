// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionTitle } from '@/components/shell/atoms';

export default function BackupPage() {
  return (
    <div className="space-y-4">
      <SectionTitle>Backup</SectionTitle>
      <div className="rounded-md border border-running bg-running-bg p-4">
        <p className="font-mono text-[10.5px] uppercase tracking-[1px] text-running">Keep your secret</p>
        <p className="mt-1 text-[13px] text-fg-muted">
          Your <code className="font-mono">LOOTGOBLIN_SECRET</code> encrypts all stored source credentials. If you lose it, those credentials become unrecoverable.
        </p>
      </div>
      <p className="text-[13px] text-fg-faint">Backup download coming soon. For now, copy <code className="font-mono text-fg">/config/lootgoblin.db</code> from the container volume.</p>
    </div>
  );
}
