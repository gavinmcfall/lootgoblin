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
      className="rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-accent-ink shadow-sm hover:opacity-90 disabled:opacity-40"
    >
      ▶ Go ({count})
    </button>
  );
}
