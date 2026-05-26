/**
 * /setup — first-run wizard (V2-012)
 *
 * Server component. Reads first-run state:
 *   - needsSetup: false → redirect to /login (setup already complete).
 *   - otherwise renders the polished pre-app frame with an interactive
 *     <SetupWizard> child seeded with the initial state.
 *
 * The wizard advances through phases (no-admin → pending-wizard → complete)
 * by re-reading state from the backend after each step. Logic lives in
 * components/preapp/SetupWizard.tsx.
 */

import { redirect } from 'next/navigation';
import { getFirstRunState } from '@/setup/first-run';
import { PreAppFrame } from '@/components/preapp/PreAppFrame';
import { SetupWizard } from '@/components/preapp/SetupWizard';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  const state = await getFirstRunState();
  if (!state.needsSetup) {
    redirect('/login');
  }

  return (
    <PreAppFrame>
      <SetupWizard initialState={state} />
    </PreAppFrame>
  );
}
