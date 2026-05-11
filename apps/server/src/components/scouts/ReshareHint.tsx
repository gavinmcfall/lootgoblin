'use client';
import { Tile } from '@/components/shell/atoms';

export function ReshareHint({ sourceId }: { sourceId: string }) {
  return (
    <Tile className="p-3">
      <p className="font-mono text-[12.5px] text-fg">
        No credentials for <code className="font-mono text-fg">{sourceId}</code> yet.
      </p>
      <p className="mt-1.5 font-mono text-[10px] text-fg-faint">
        Install the LootGoblin browser extension, sign in to the site, and click{' '}
        <span className="text-fg">Share session</span> in the extension popup.
      </p>
    </Tile>
  );
}
