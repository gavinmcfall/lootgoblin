import { NextResponse } from 'next/server';
import { tasks, getLastRun } from '@/workers/tasks';
import { getSetting, setSetting } from '@/lib/settings';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';

export async function GET(req: Request) {
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  // System tasks are instance_config adjacent: read by any authenticated user.
  const acl = resolveAcl({ user, resource: { kind: 'instance_config' }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });
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
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  // Toggling system tasks is an instance_config update — admin only.
  const acl = resolveAcl({ user, resource: { kind: 'instance_config' }, action: 'update' });
  if (!acl.allowed) return NextResponse.json({ error: acl.reason ?? 'unauthorized' }, { status: user ? 403 : 401 });
  const { id, enabled } = (await req.json()) as { id: string; enabled: boolean };
  const task = tasks.find((t) => t.id === id);
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await setSetting(`task_${id}_enabled`, enabled);
  return NextResponse.json({ ok: true });
}
