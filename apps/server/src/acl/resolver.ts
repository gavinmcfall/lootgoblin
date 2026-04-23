/**
 * ACL resolver — V2-001-T7
 *
 * Pure function: resolveAcl({ user, resource, action }) → AclDecision.
 *
 * All per-route inline session+role checks delegate to this module instead.
 * The resolver encodes the full v2 permission matrix in one place so that
 * policy changes are auditable, testable, and free of handler-level drift.
 *
 * Role model
 * ──────────
 * v2 uses two roles: 'admin' and 'user'. Role is stored on BetterAuth's
 * `member` table (column: role). The helpers.ts `getSessionOrNull` wrapper
 * now resolves the member role and attaches it to the returned session shape
 * so every downstream caller sees it without re-querying the DB.
 *
 * Printer / Slicer owner-consent model
 * ─────────────────────────────────────
 * Printers and slicers are personal devices. Admins cannot bypass printer
 * or slicer ACL — if an admin wants push access to someone else's printer
 * they must be granted explicitly via `aclGrantees`. This is intentional:
 * printing on someone else's hardware without their consent is wrong even
 * with admin authority.
 *
 * Two-API-key systems
 * ───────────────────
 * v2 currently has two API-key systems: the custom `api_keys` Drizzle table
 * (argon2id hashed, scoped) and BetterAuth's `apikey` table. V2-001-T7
 * kept them separate to scope ACL work cleanly; a future cleanup task will
 * unify them. See apps/server/src/auth/README.md for details.
 *
 * Deny reasons
 * ─────────────
 *   unauthenticated  — no user session present.
 *   not-owner        — action requires ownership; caller is not the owner.
 *   admin-required   — only admins may perform this action.
 *   not-in-acl       — resource has an explicit ACL; caller is not listed.
 *   wrong-action     — action is structurally invalid for this resource
 *                      (e.g. write to ledger_event, which is append-only internally).
 */

// ── Resource discriminated union ─────────────────────────────────────────────

export type AclResource =
  | { kind: 'collection'; ownerId?: string; id?: string }
  | { kind: 'loot'; ownerId?: string; collectionId?: string; id?: string }
  | { kind: 'printer'; ownerId?: string; id?: string; aclGrantees?: string[] }
  | { kind: 'slicer'; ownerId?: string; id?: string; aclGrantees?: string[] }
  | { kind: 'material'; ownerId?: string; id?: string }
  | { kind: 'watchlist_subscription'; ownerId?: string; id?: string }
  | { kind: 'grimoire_entry'; ownerId?: string; id?: string }
  | { kind: 'user'; id?: string }
  | { kind: 'instance_config' }
  | { kind: 'api_key'; ownerId?: string; id?: string }
  | { kind: 'ledger_event' };

export type AclAction = 'read' | 'create' | 'update' | 'delete' | 'push';

export interface AclUser {
  id: string;
  role: 'admin' | 'user';
}

export type AclDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'not-owner' | 'admin-required' | 'not-in-acl' | 'wrong-action' };

// ── Convenience constants ────────────────────────────────────────────────────

const ALLOW: AclDecision = { allowed: true };

function deny(reason: 'unauthenticated' | 'not-owner' | 'admin-required' | 'not-in-acl' | 'wrong-action'): AclDecision {
  return { allowed: false, reason };
}

function isOwner(user: AclUser, resource: { ownerId?: string }): boolean {
  return resource.ownerId !== undefined && user.id === resource.ownerId;
}

function isSelf(user: AclUser, resource: { id?: string }): boolean {
  return resource.id !== undefined && user.id === resource.id;
}

// ── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolves whether the given user may perform `action` on `resource`.
 *
 * Pass `user: null` for unauthenticated callers — always Deny('unauthenticated').
 */
export function resolveAcl(args: {
  user: AclUser | null;
  resource: AclResource;
  action: AclAction;
}): AclDecision {
  const { user, resource, action } = args;

  // Unauthenticated — deny everything at the ACL layer.
  if (!user) return deny('unauthenticated');

  switch (resource.kind) {
    // ── collection ────────────────────────────────────────────────────────
    case 'collection': {
      if (action === 'read') return ALLOW; // all authenticated users
      if (action === 'create') return ALLOW; // any user may create
      // update / delete: owner or admin
      if (action === 'update' || action === 'delete') {
        if (user.role === 'admin') return ALLOW;
        return isOwner(user, resource) ? ALLOW : deny('not-owner');
      }
      return deny('wrong-action');
    }

    // ── loot ──────────────────────────────────────────────────────────────
    case 'loot': {
      if (action === 'read') return ALLOW; // all authenticated users
      if (action === 'create') return ALLOW; // any user may create
      // update / delete: owner (via owning collection) or admin
      if (action === 'update' || action === 'delete') {
        if (user.role === 'admin') return ALLOW;
        return isOwner(user, resource) ? ALLOW : deny('not-owner');
      }
      return deny('wrong-action');
    }

    // ── printer ───────────────────────────────────────────────────────────
    // Admins DO NOT bypass printer/slicer ACL. Owner-consent model.
    case 'printer': {
      if (action === 'read') return ALLOW; // fleet-visible
      if (action === 'push') {
        // push: owner OR explicit grantee. Admins NOT exempt.
        if (isOwner(user, resource)) return ALLOW;
        if (resource.aclGrantees?.includes(user.id)) return ALLOW;
        return deny('not-in-acl');
      }
      if (action === 'update' || action === 'delete') {
        return isOwner(user, resource) ? ALLOW : deny('not-owner');
      }
      if (action === 'create') {
        // Any user may register a printer (they become the owner).
        return ALLOW;
      }
      return deny('wrong-action');
    }

    // ── slicer ────────────────────────────────────────────────────────────
    // Same consent model as printer.
    case 'slicer': {
      if (action === 'read') return ALLOW; // fleet-visible
      if (action === 'push') {
        if (isOwner(user, resource)) return ALLOW;
        if (resource.aclGrantees?.includes(user.id)) return ALLOW;
        return deny('not-in-acl');
      }
      if (action === 'update' || action === 'delete') {
        return isOwner(user, resource) ? ALLOW : deny('not-owner');
      }
      if (action === 'create') return ALLOW;
      return deny('wrong-action');
    }

    // ── material ──────────────────────────────────────────────────────────
    case 'material': {
      // Admin read is allowed (aggregate consumption reporting).
      if (action === 'read') {
        if (user.role === 'admin') return ALLOW;
        return isOwner(user, resource) ? ALLOW : deny('not-owner');
      }
      // All write actions: owner-only.
      if (action === 'create') return ALLOW; // creating = becoming owner
      if (action === 'update' || action === 'delete') {
        return isOwner(user, resource) ? ALLOW : deny('not-owner');
      }
      return deny('wrong-action');
    }

    // ── watchlist_subscription ────────────────────────────────────────────
    case 'watchlist_subscription': {
      // Owner-only CRUD; admin cannot access.
      if (action === 'push') return deny('wrong-action');
      if (action === 'create') return ALLOW;
      return isOwner(user, resource) ? ALLOW : deny('not-owner');
    }

    // ── grimoire_entry ────────────────────────────────────────────────────
    case 'grimoire_entry': {
      // Owner-only CRUD; admin cannot access.
      if (action === 'push') return deny('wrong-action');
      if (action === 'create') return ALLOW;
      return isOwner(user, resource) ? ALLOW : deny('not-owner');
    }

    // ── user ──────────────────────────────────────────────────────────────
    case 'user': {
      if (action === 'read') {
        // Self read always allowed; admin reads all.
        if (user.role === 'admin') return ALLOW;
        return isSelf(user, resource) ? ALLOW : deny('admin-required');
      }
      if (action === 'create') {
        return user.role === 'admin' ? ALLOW : deny('admin-required');
      }
      if (action === 'update') {
        // Self-update allowed (password, display name enforced at route level).
        if (user.role === 'admin') return ALLOW;
        return isSelf(user, resource) ? ALLOW : deny('admin-required');
      }
      if (action === 'delete') {
        return user.role === 'admin' ? ALLOW : deny('admin-required');
      }
      return deny('wrong-action');
    }

    // ── instance_config ───────────────────────────────────────────────────
    case 'instance_config': {
      if (action === 'read') return ALLOW; // all authenticated users
      if (action === 'update') {
        return user.role === 'admin' ? ALLOW : deny('admin-required');
      }
      // create / delete / push are not meaningful for instance_config.
      return deny('wrong-action');
    }

    // ── api_key ───────────────────────────────────────────────────────────
    case 'api_key': {
      // Owner: create / read / delete their own keys.
      // Admin: read all keys (reporting).
      // Admin cannot create/delete keys on behalf of another user.
      if (action === 'read') {
        if (user.role === 'admin') return ALLOW;
        return isOwner(user, resource) ? ALLOW : deny('not-owner');
      }
      if (action === 'create') {
        // Creating a key for yourself is always allowed.
        // Creating for another user: admin-only.
        if (!resource.ownerId || resource.ownerId === user.id) return ALLOW;
        return user.role === 'admin' ? ALLOW : deny('admin-required');
      }
      if (action === 'delete') {
        return isOwner(user, resource) ? ALLOW : deny('not-owner');
      }
      // update / push not meaningful.
      return deny('wrong-action');
    }

    // ── ledger_event ──────────────────────────────────────────────────────
    case 'ledger_event': {
      // Read: admin-only.
      // Write: structurally prohibited — Ledger is append-only via internal event emission.
      if (action === 'read') {
        return user.role === 'admin' ? ALLOW : deny('admin-required');
      }
      // create / update / delete / push are structurally invalid.
      return deny('wrong-action');
    }

    default: {
      // Exhaustiveness guard — TypeScript will flag unhandled cases at compile time.
      const _exhaustive: never = resource;
      void _exhaustive;
      return deny('wrong-action');
    }
  }
}
