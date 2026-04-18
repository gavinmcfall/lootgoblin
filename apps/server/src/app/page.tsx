export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { runMigrations, countUsers } from '@/db/client';
import { auth } from '@/auth';

export default async function Home() {
  await runMigrations();
  const userCount = await countUsers();
  if (userCount === 0) redirect('/setup');
  const session = await auth();
  if (!session) redirect('/login');
  return <main className="p-8"><h1 className="text-xl font-semibold">LootGoblin</h1><p className="mt-2 text-slate-400">Activity (coming in Plan C)</p></main>;
}
