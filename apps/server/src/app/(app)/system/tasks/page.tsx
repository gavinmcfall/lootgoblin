'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SectionTitle, Tile, MetaBadge, EmptyHint } from '@/components/shell/atoms';

interface Task {
  id: string;
  label: string;
  intervalMs: number;
  enabled: boolean;
  lastRunAt: number | null;
}

export default function TasksPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
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

  const tasks = data?.tasks ?? [];

  return (
    <div className="space-y-4">
      <SectionTitle meta={`${tasks.length} task${tasks.length === 1 ? '' : 's'}`}>System tasks</SectionTitle>
      {isError && <EmptyHint>Failed to load tasks.</EmptyHint>}
      {isLoading ? (
        <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>
      ) : tasks.length === 0 ? (
        <EmptyHint>No scheduled tasks.</EmptyHint>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <Tile key={t.id} className="p-3 flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-fg">{t.label}</div>
                <div className="mt-0.5 font-mono text-[10px] tracking-[0.5px] text-fg-faint">
                  every {Math.round(t.intervalMs / 60_000)}m · {t.lastRunAt ? `last ran ${new Date(t.lastRunAt).toLocaleString()}` : 'never run yet'}
                </div>
              </div>
              <label htmlFor={`task-${t.id}`} className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.6px] text-fg-muted">
                <input
                  id={`task-${t.id}`}
                  type="checkbox"
                  checked={t.enabled}
                  onChange={(e) => toggle(t.id, e.target.checked)}
                />
                <MetaBadge tone={t.enabled ? 'success' : 'neutral'}>{t.enabled ? 'enabled' : 'disabled'}</MetaBadge>
              </label>
            </Tile>
          ))}
        </div>
      )}
    </div>
  );
}
