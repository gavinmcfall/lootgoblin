'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface Task {
  id: string;
  label: string;
  intervalMs: number;
  enabled: boolean;
  lastRunAt: number | null;
}

export default function TasksPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['system-tasks'],
    queryFn: async (): Promise<{ tasks: Task[] }> => (await fetch('/api/v1/system/tasks')).json(),
  });

  async function toggle(id: string, enabled: boolean) {
    const res = await fetch('/api/v1/system/tasks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    });
    if (res.ok) { toast.success(`${id} ${enabled ? 'enabled' : 'disabled'}`); qc.invalidateQueries({ queryKey: ['system-tasks'] }); }
    else toast.error('Update failed');
  }

  if (isLoading) return <p className="text-sm text-slate-400">Loading…</p>;
  const tasks = data?.tasks ?? [];

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-100">System — Tasks</h2>
      {tasks.length === 0 ? (
        <p className="text-sm text-slate-500">No scheduled tasks.</p>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900 p-3">
              <div>
                <div className="text-sm font-medium text-slate-100">{t.label}</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  every {Math.round(t.intervalMs / 60_000)}m · {t.lastRunAt ? `last ran ${new Date(t.lastRunAt).toLocaleString()}` : 'never run yet'}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={t.enabled}
                  onChange={(e) => toggle(t.id, e.target.checked)}
                />
                {t.enabled ? 'Enabled' : 'Disabled'}
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
