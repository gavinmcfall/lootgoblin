import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { runMigrations } from '@/db/client';
import { getDb } from '@/db/client';
import * as authSchema from '@/db/schema.auth';
import { auth } from '@/auth';
import { Sidebar } from '@/components/shell/Sidebar';
import { Topbar } from '@/components/shell/Topbar';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await runMigrations();

  // Check if any users exist in BetterAuth's user table.
  const db = getDb() as any;
  const existingUsers = await db.select({ id: authSchema.user.id }).from(authSchema.user).limit(1);
  if (existingUsers.length === 0) redirect('/setup');

  // Validate session — redirect to login if not authenticated.
  const hdrs = await headers();
  const session = await auth.api.getSession({ headers: hdrs });
  if (!session) redirect('/login');

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Topbar />
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
