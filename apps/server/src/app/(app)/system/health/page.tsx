'use client';
import { useQuery } from '@tanstack/react-query';

interface HealthReport {
  status: 'ok' | 'degraded' | 'fail';
  checks: { db: 'ok' | 'fail'; secret: 'ok' | 'fail'; disk: 'ok' | 'fail' };
}

const COLOR = {
  ok: 'border-emerald-600 text-emerald-300',
  fail: 'border-red-600 text-red-300',
} as const;

export default function HealthPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['health'],
    queryFn: async (): Promise<HealthReport> => (await fetch('/api/health')).json(),
    refetchInterval: 10_000,
  });

  if (isLoading || !data) return <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-100">System — Health</h2>
      <p className="text-sm text-slate-400">Overall: <span className={data.status === 'ok' ? 'text-emerald-300' : 'text-red-300'}>{data.status}</span></p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Object.entries(data.checks).map(([key, status]) => (
          <div key={key} className={`rounded-lg border bg-slate-900 p-4 ${COLOR[status]}`}>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{key}</div>
            <div className="mt-1 text-xl font-semibold">{status}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
