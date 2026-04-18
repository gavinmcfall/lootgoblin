'use client';
import { toast } from 'sonner';

export function GoButton({ count }: { count: number }) {
  async function go() {
    const res = await fetch('/api/v1/jobs/run', { method: 'POST' });
    if (res.ok) toast.success(`Triggered (${count} queued)`);
    else toast.error('Failed to trigger');
  }
  return (
    <button
      onClick={go}
      disabled={count === 0}
      className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
    >
      ▶ Go ({count})
    </button>
  );
}
