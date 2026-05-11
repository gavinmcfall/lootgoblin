'use client';
import { useQuery } from '@tanstack/react-query';
import { SectionTitle, MetaBadge, EmptyHint, type Tone } from '@/components/shell/atoms';

interface HealthReport {
  status: 'ok' | 'degraded' | 'fail';
  checks: { db: 'ok' | 'fail'; secret: 'ok' | 'fail'; disk: 'ok' | 'fail' };
}

function overallTone(s: HealthReport['status']): Tone {
  if (s === 'ok') return 'success';
  if (s === 'degraded') return 'running';
  return 'danger';
}

export default function HealthPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['health'],
    queryFn: async (): Promise<HealthReport> => (await fetch('/api/health')).json(),
    refetchInterval: 10_000,
  });

  if (isError) return <EmptyHint>Failed to load health data.</EmptyHint>;
  if (isLoading || !data) return <EmptyHint>Loading…</EmptyHint>;

  return (
    <div className="space-y-4">
      <SectionTitle right={<MetaBadge tone={overallTone(data.status)}>{data.status}</MetaBadge>}>System health</SectionTitle>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Object.entries(data.checks).map(([key, status]) => {
          const borderClass = status === 'ok' ? 'border-success' : 'border-danger';
          const textClass = status === 'ok' ? 'text-success' : 'text-danger';
          return (
            <div key={key} className={`rounded-md border bg-surface p-4 ${borderClass}`}>
              <div className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint">{key}</div>
              <div className={`mt-1 text-[18px] font-semibold ${textClass}`}>{status}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
