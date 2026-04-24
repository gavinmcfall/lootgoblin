/**
 * /setup page scaffold — V2-001-T8
 *
 * Server component. Checks first-run state and renders the appropriate form:
 *   - no-admin: form to create the first admin user (POST /api/setup)
 *   - pending-wizard: form per pending key (POST /api/v1/setup/wizard)
 *   - needsSetup: false: redirect to /login
 *
 * No styling beyond globals.css — V2-012 will replace this with the full
 * design-polished wizard.
 */

import { redirect } from 'next/navigation';
import { getFirstRunState } from '@/setup/first-run';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  const state = await getFirstRunState();

  if (!state.needsSetup) {
    redirect('/login');
  }

  if (state.reason === 'no-admin') {
    return (
      <main>
        <h1>Welcome to LootGoblin</h1>
        <p>Create your admin account to get started.</p>
        <form method="POST" action="/api/setup">
          <div>
            <label htmlFor="name">Name</label>
            <input id="name" name="name" type="text" required />
          </div>
          <div>
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required />
          </div>
          <div>
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required />
          </div>
          <button type="submit">Create Admin Account</button>
        </form>
      </main>
    );
  }

  // reason === 'pending-wizard'
  return (
    <main>
      <h1>LootGoblin Setup</h1>
      <p>Complete the following configuration to finish setup.</p>
      {state.pendingKeys.map((key) => (
        <form
          key={key}
          onSubmit={undefined}
          data-wizard-key={key}
        >
          <label htmlFor={`wizard-${key}`}>{key}</label>
          <input id={`wizard-${key}`} name="value" type="text" required />
          <input type="hidden" name="key" value={key} />
          <button
            type="button"
            onClick={undefined}
            data-action="wizard-submit"
            data-key={key}
          >
            Save
          </button>
        </form>
      ))}
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function() {
  document.querySelectorAll('[data-action="wizard-submit"]').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      var key = btn.dataset.key;
      var form = btn.closest('form');
      var value = form.querySelector('input[name="value"]').value;
      if (!value) return;
      var res = await fetch('/api/v1/setup/wizard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: key, value: value }),
      });
      var body = await res.json();
      if (!body.needsSetup) {
        window.location.href = '/login';
      } else {
        window.location.reload();
      }
    });
  });
})();
          `,
        }}
      />
    </main>
  );
}
