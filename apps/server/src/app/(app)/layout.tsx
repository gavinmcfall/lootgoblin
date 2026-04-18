import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { runMigrations, countUsers } from '@/db/client';
import { Sidebar } from '@/components/shell/Sidebar';
import { Topbar } from '@/components/shell/Topbar';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await runMigrations();
  const userCount = await countUsers();
  if (userCount === 0) redirect('/setup');
  const session = await auth();
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
