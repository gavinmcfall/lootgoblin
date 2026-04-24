/**
 * Root page — V2-001-T8
 *
 * Server component. Acts as the initial routing hub:
 *   - If setup is needed, redirect to /setup.
 *   - Otherwise the middleware will redirect unauthenticated users to /login.
 *     For authenticated users (who bypassed the middleware redirect), send
 *     them on to /activity.
 *
 * This non-grouped page.tsx takes precedence over (app)/page.tsx for the
 * root '/' route in Next.js 15.
 */

import { redirect } from 'next/navigation';
import { getFirstRunState } from '@/setup/first-run';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const state = await getFirstRunState();

  if (state.needsSetup) {
    redirect('/setup');
  }

  // Authenticated users land here after middleware lets them through.
  // Unauthenticated users are redirected to /login by the middleware before
  // this component even renders.
  redirect('/activity');
}
