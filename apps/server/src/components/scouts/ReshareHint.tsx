'use client';

export function ReshareHint({ sourceId }: { sourceId: string }) {
  return (
    <div className="rounded border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-400">
      <p className="font-medium text-slate-300">No credentials for <code className="text-slate-100">{sourceId}</code> yet.</p>
      <p className="mt-1">
        Install the LootGoblin browser extension, sign in to the site, and click <span className="text-slate-200">Share session</span> in the extension popup.
      </p>
    </div>
  );
}
