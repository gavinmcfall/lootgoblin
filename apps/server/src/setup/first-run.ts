/**
 * First-run detection — V2-001-T8
 *
 * Determines whether the instance needs setup by checking:
 *   1. Whether any admin user exists in BetterAuth's user table.
 *   2. Whether the config resolver has any pending-wizard keys.
 *
 * Precedence:
 *   - Zero users → reason: 'no-admin' (admin creation must come first).
 *   - Admin exists + pending keys → reason: 'pending-wizard'.
 *   - Admin exists + no pending keys → needsSetup: false.
 */

import type { ConfigResolver } from '../config/resolver.js';
import { configResolver as defaultConfigResolver } from '../config/index.js';

export type FirstRunState =
  | { needsSetup: false }
  | { needsSetup: true; reason: 'no-admin'; pendingKeys: string[] }
  | { needsSetup: true; reason: 'pending-wizard'; pendingKeys: string[] };

/**
 * Returns the current first-run state.
 *
 * @param resolver - Config resolver to query for pending-wizard keys.
 *   Defaults to the application singleton. Pass a custom instance in tests.
 */
export async function getFirstRunState(
  resolver: ConfigResolver = defaultConfigResolver,
): Promise<FirstRunState> {
  // Check for existing users via Drizzle (lazy import avoids circular deps).
  const { getDb } = await import('../db/client.js');
  const { user } = await import('../db/schema.auth.js');

  const db = getDb() as any;
  const rows = await db.select({ id: user.id }).from(user).limit(1);
  const hasAdmin = rows.length > 0;

  const pendingKeys = resolver.getPendingWizardKeys();

  if (!hasAdmin) {
    // No admin yet — admin creation is always the first step.
    return { needsSetup: true, reason: 'no-admin', pendingKeys };
  }

  if (pendingKeys.length > 0) {
    return { needsSetup: true, reason: 'pending-wizard', pendingKeys };
  }

  return { needsSetup: false };
}
