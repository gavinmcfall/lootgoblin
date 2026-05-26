/**
 * /login — pre-app authentication (V2-012)
 *
 * Server component. Checks first-run state:
 *   - If setup is needed, redirect to /setup.
 *   - Otherwise reads resolved config (hasOidc + passwordLoginEnabled) and
 *     renders the polished login frame with an interactive <LoginForm> child.
 *
 * The interactive sign-in logic lives in components/preapp/LoginForm.tsx.
 */

import { redirect } from 'next/navigation';
import { getFirstRunState } from '@/setup/first-run';
import { configResolver } from '@/config';
import { PreAppFrame } from '@/components/preapp/PreAppFrame';
import { LoginForm } from '@/components/preapp/LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const state = await getFirstRunState();
  if (state.needsSetup) {
    redirect('/setup');
  }

  // Read resolved config. getResolved() is null until instrumentation.ts has
  // run resolve() (e.g. during build-time prerender), so degrade to safe
  // defaults: password login on, no OIDC.
  const resolved = configResolver.getResolved();
  const passwordLoginEnabled = resolved?.PASSWORD_LOGIN_ENABLED ?? true;
  const hasOidc = !!(
    resolved?.OIDC_ISSUER_URL &&
    resolved?.OIDC_CLIENT_ID &&
    resolved?.OIDC_CLIENT_SECRET
  );

  return (
    <PreAppFrame>
      <LoginForm hasOidc={hasOidc} passwordLoginEnabled={passwordLoginEnabled} />
    </PreAppFrame>
  );
}
