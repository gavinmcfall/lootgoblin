/**
 * /login page scaffold — V2-001-T8
 *
 * Server component. Checks first-run state:
 *   - If setup is needed, redirect to /setup.
 *   - Otherwise renders a minimal email/password form that submits to
 *     BetterAuth's sign-in endpoint (/api/auth/sign-in/email).
 *
 * No styling beyond globals.css — V2-012 will replace this with the
 * design-polished login page.
 */

import { redirect } from 'next/navigation';
import { getFirstRunState } from '@/setup/first-run';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const state = await getFirstRunState();

  if (state.needsSetup) {
    redirect('/setup');
  }

  return (
    <main>
      <h1>Sign in to LootGoblin</h1>
      <form id="login-form">
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required />
        </div>
        <button type="submit">Sign in</button>
      </form>
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function() {
  document.getElementById('login-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var email = document.getElementById('email').value;
    var password = document.getElementById('password').value;
    var res = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    });
    if (res.ok) {
      var params = new URLSearchParams(window.location.search);
      var raw = params.get('callbackUrl');
      // Same-origin guard: only accept absolute paths ('/foo'), reject
      // protocol-relative ('//evil') and absolute URLs ('https://evil').
      var safe = raw && raw.charAt(0) === '/' && raw.charAt(1) !== '/' ? raw : '/activity';
      window.location.href = safe;
    } else {
      var body = await res.json().catch(function() { return {}; });
      alert(body.message || 'Sign in failed. Check your email and password.');
    }
  });
})();
          `,
        }}
      />
    </main>
  );
}
