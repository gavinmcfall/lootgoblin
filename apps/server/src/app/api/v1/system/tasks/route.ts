import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { tasks, getLastRun } from '@/workers/tasks';
import { getSetting, setSetting } from '@/lib/settings';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const out = await Promise.all(tasks.map(async (t) => ({
    id: t.id,
    label: t.label,
    intervalMs: t.intervalMs,
    enabled: (await getSetting<boolean>(`task_${t.id}_enabled`)) ?? t.enabledDefault,
    lastRunAt: getLastRun(t.id) ?? null,
  })));
  return NextResponse.json({ tasks: out });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, enabled } = (await req.json()) as { id: string; enabled: boolean };
  const task = tasks.find((t) => t.id === id);
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await setSetting(`task_${id}_enabled`, enabled);
  return NextResponse.json({ ok: true });
}
