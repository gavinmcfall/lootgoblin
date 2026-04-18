import type { PairedState } from '@/lib/storage';

export function StatusView({ state, onUnpair }: { state: PairedState; onUnpair: () => void }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-400">
        Paired with <span className="font-mono text-slate-200">{state.serverUrl}</span>
      </div>
      <p className="text-xs text-slate-500">Full status view ships in D-5.</p>
      <button onClick={onUnpair} className="w-full rounded border border-slate-700 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
        Unpair
      </button>
    </div>
  );
}
