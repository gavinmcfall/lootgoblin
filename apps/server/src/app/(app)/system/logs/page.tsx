// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionTitle, Tile } from '@/components/shell/atoms';

export default function LogsPage() {
  return (
    <div className="space-y-4">
      <SectionTitle>System logs</SectionTitle>
      <Tile className="p-4 max-w-2xl">
        <p className="text-[13px] text-fg-muted">Structured logs stream to stdout. For now, view them in the server terminal or aggregator (OTEL / docker logs).</p>
        <p className="mt-2 text-[11.5px] text-fg-faint">
          A live tail UI is planned — requires wiring pino to a file sink and SSE streaming the tail. Tracked as post-v1.
        </p>
      </Tile>
    </div>
  );
}
