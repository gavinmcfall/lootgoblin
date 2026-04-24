/**
 * Tests for OIDC group-to-role mapping logic — V2-001-T4
 *
 * The actual mapping runs inside the BetterAuth after-sign-in hook in
 * auth/index.ts and interacts with the database directly. These tests
 * validate the pure mapping logic (group array + claim string → role string)
 * in isolation without touching the DB or BetterAuth runtime.
 *
 * The hook code:
 *   const desiredRole = groups.includes(oidcAdminGroupClaim) ? 'admin' : 'member';
 *
 * We test the mapping function extracted here to keep the tests fast and
 * dependency-free.
 */

import { describe, it, expect } from 'vitest';

/**
 * Pure mapping function mirroring the hook logic in auth/index.ts.
 * Extracted for testability without needing BetterAuth or a DB.
 */
function resolveRole(groups: string[], adminGroupClaim: string): 'admin' | 'member' {
  return groups.includes(adminGroupClaim) ? 'admin' : 'member';
}

describe('OIDC group-to-role mapping', () => {
  describe('with default claim "admin"', () => {
    const claim = 'admin';

    it('returns admin when groups includes the admin claim', () => {
      expect(resolveRole(['admin', 'users'], claim)).toBe('admin');
    });

    it('returns member when groups does not include the admin claim', () => {
      expect(resolveRole(['users', 'editors'], claim)).toBe('member');
    });

    it('returns member for an empty groups array', () => {
      expect(resolveRole([], claim)).toBe('member');
    });

    it('returns member when admin claim is a substring but not an exact match', () => {
      // 'administrators' should NOT match 'admin'
      expect(resolveRole(['administrators', 'superadmin'], claim)).toBe('member');
    });
  });

  describe('with custom claim', () => {
    it('uses the custom claim for matching', () => {
      expect(resolveRole(['lootgoblin-admins', 'users'], 'lootgoblin-admins')).toBe('admin');
      expect(resolveRole(['admins'], 'lootgoblin-admins')).toBe('member');
    });
  });

  describe('role demotion on removal', () => {
    it('demotes to member when the user is removed from the admin group', () => {
      const adminGroupClaim = 'admin';

      // First login — user is in admin group.
      const roleOnFirstLogin = resolveRole(['admin', 'users'], adminGroupClaim);
      expect(roleOnFirstLogin).toBe('admin');

      // Second login — user removed from admin group.
      const roleAfterRemoval = resolveRole(['users'], adminGroupClaim);
      expect(roleAfterRemoval).toBe('member');
    });

    it('re-promotes to admin when the user is added back to the admin group', () => {
      const adminGroupClaim = 'admin';
      const roleAfterReadd = resolveRole(['users', 'admin'], adminGroupClaim);
      expect(roleAfterReadd).toBe('admin');
    });
  });
});
