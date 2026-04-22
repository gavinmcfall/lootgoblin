import { redirect } from 'next/navigation';
import { runMigrations, countUsers } from '@/db/client';
import { Sidebar } from '@/components/shell/Sidebar';
import { Topbar } from '@/components/shell/Topbar';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await runMigrations();
  const userCount = await countUsers();
  if (userCount === 0) redirect('/setup');
  // TODO: auth integration pending V2-001-T2 (BetterAuth install)
  // Session validation will be added in the auth plugin.
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
