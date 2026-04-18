'use client';

export function StatRow({ queued, running, done24h, failed }: { queued: number; running: number; done24h: number; failed: number }) {
  const tiles = [
    { label: 'QUEUED', value: queued, border: 'border-slate-700', valueCls: 'text-slate-100' },
    { label: 'RUNNING', value: running, border: 'border-emerald-600', valueCls: 'text-emerald-300' },
    { label: 'COMPLETED 24h', value: done24h, border: 'border-slate-700', valueCls: 'text-slate-100' },
    { label: 'FAILED', value: failed, border: 'border-red-600', valueCls: 'text-red-300' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className={`rounded-lg border bg-slate-900 p-3 ${t.border}`}>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">{t.label}</div>
          <div className={`mt-1 text-2xl font-semibold ${t.valueCls}`}>{t.value}</div>
        </div>
      ))}
    </div>
  );
}
