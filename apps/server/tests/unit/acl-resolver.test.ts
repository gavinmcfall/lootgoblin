/**
 * ACL resolver permission matrix tests — V2-001-T7
 *
 * Comprehensive test coverage for every (resource, action, user) combination
 * codified in resolveAcl(). Uses Vitest test.each for readable tabular form.
 *
 * Notation used in test descriptions:
 *   admin      — user with role 'admin'
 *   user       — user with role 'user'
 *   owner      — user whose id matches resource.ownerId
 *   non-owner  — user whose id does NOT match resource.ownerId
 *   grantee    — user listed in printer/slicer aclGrantees
 *   null       — unauthenticated (no session)
 */

import { describe, it, expect } from 'vitest';
import { resolveAcl } from '../../src/acl/resolver';
import type { AclUser, AclResource, AclAction, AclDecision } from '../../src/acl/resolver';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const ADMIN: AclUser = { id: 'admin-1', role: 'admin' };
const USER_A: AclUser = { id: 'user-a', role: 'user' };
const USER_B: AclUser = { id: 'user-b', role: 'user' };

// Resource factories
function collection(ownerId?: string): AclResource {
  return { kind: 'collection', ownerId, id: ownerId ? `coll-${ownerId}` : undefined };
}
function loot(ownerId?: string): AclResource {
  return { kind: 'loot', ownerId, id: ownerId ? `loot-${ownerId}` : undefined };
}
function printer(ownerId?: string, aclGrantees?: string[]): AclResource {
  return { kind: 'printer', ownerId, id: ownerId ? `printer-${ownerId}` : undefined, aclGrantees };
}
function slicer(ownerId?: string, aclGrantees?: string[]): AclResource {
  return { kind: 'slicer', ownerId, id: ownerId ? `slicer-${ownerId}` : undefined, aclGrantees };
}
function material(ownerId?: string): AclResource {
  return { kind: 'material', ownerId, id: ownerId ? `mat-${ownerId}` : undefined };
}
function watchlistSub(ownerId?: string): AclResource {
  return { kind: 'watchlist_subscription', ownerId, id: ownerId ? `ws-${ownerId}` : undefined };
}
function grimoireEntry(ownerId?: string): AclResource {
  return { kind: 'grimoire_entry', ownerId, id: ownerId ? `ge-${ownerId}` : undefined };
}
function userResource(id?: string): AclResource {
  return { kind: 'user', id };
}
function instanceConfig(): AclResource {
  return { kind: 'instance_config' };
}
function apiKey(ownerId?: string): AclResource {
  return { kind: 'api_key', ownerId, id: ownerId ? `key-${ownerId}` : undefined };
}
function ledgerEvent(): AclResource {
  return { kind: 'ledger_event' };
}

type TestRow = [
  description: string,
  user: AclUser | null,
  resource: AclResource,
  action: AclAction,
  expected: boolean,
  expectedReason?: string,
];

function allowed(): Pick<AclDecision, 'allowed'> {
  return { allowed: true };
}
function denied(reason: string): Pick<AclDecision, 'allowed' | 'reason'> {
  return { allowed: false, reason } as Pick<AclDecision, 'allowed' | 'reason'>;
}

// ── Unauthenticated (null user) — always deny ─────────────────────────────────

describe('unauthenticated user (null) → always Deny(unauthenticated)', () => {
  const cases: TestRow[] = [
    ['collection read',        null, collection('user-a'),  'read',   false, 'unauthenticated'],
    ['collection create',      null, collection(),           'create', false, 'unauthenticated'],
    ['loot read',              null, loot('user-a'),         'read',   false, 'unauthenticated'],
    ['printer read',           null, printer('user-a'),      'read',   false, 'unauthenticated'],
    ['printer push',           null, printer('user-a'),      'push',   false, 'unauthenticated'],
    ['slicer read',            null, slicer('user-a'),       'read',   false, 'unauthenticated'],
    ['material read',          null, material('user-a'),     'read',   false, 'unauthenticated'],
    ['watchlist_sub read',     null, watchlistSub('user-a'), 'read',   false, 'unauthenticated'],
    ['grimoire read',          null, grimoireEntry('user-a'),'read',   false, 'unauthenticated'],
    ['user read',              null, userResource('user-a'), 'read',   false, 'unauthenticated'],
    ['instance_config read',   null, instanceConfig(),       'read',   false, 'unauthenticated'],
    ['api_key read',           null, apiKey('user-a'),       'read',   false, 'unauthenticated'],
    ['ledger_event read',      null, ledgerEvent(),          'read',   false, 'unauthenticated'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── collection ────────────────────────────────────────────────────────────────

describe('collection', () => {
  const cases: TestRow[] = [
    // read: all authenticated
    ['admin reads any collection',         ADMIN,  collection('user-a'), 'read',   true],
    ['user reads own collection',          USER_A, collection('user-a'), 'read',   true],
    ['user reads other collection',        USER_A, collection('user-b'), 'read',   true],

    // create: all authenticated
    ['admin creates collection',           ADMIN,  collection(),          'create', true],
    ['user creates collection',            USER_A, collection(),          'create', true],

    // update: owner or admin
    ['admin updates other collection',     ADMIN,  collection('user-a'), 'update', true],
    ['user updates own collection',        USER_A, collection('user-a'), 'update', true],
    ['user updates other collection',      USER_A, collection('user-b'), 'update', false, 'not-owner'],

    // delete: owner or admin
    ['admin deletes other collection',     ADMIN,  collection('user-a'), 'delete', true],
    ['user deletes own collection',        USER_A, collection('user-a'), 'delete', true],
    ['user deletes other collection',      USER_A, collection('user-b'), 'delete', false, 'not-owner'],

    // wrong actions
    ['user pushes to collection',          USER_A, collection('user-a'), 'push',   false, 'wrong-action'],
    ['admin pushes to collection',         ADMIN,  collection('user-a'), 'push',   false, 'wrong-action'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── loot ─────────────────────────────────────────────────────────────────────

describe('loot', () => {
  const cases: TestRow[] = [
    ['admin reads loot',                   ADMIN,  loot('user-a'), 'read',   true],
    ['user reads own loot',                USER_A, loot('user-a'), 'read',   true],
    ['user reads other loot',              USER_A, loot('user-b'), 'read',   true],
    ['admin creates loot',                 ADMIN,  loot(),         'create', true],
    ['user creates loot',                  USER_A, loot(),         'create', true],
    ['admin updates other loot',           ADMIN,  loot('user-a'), 'update', true],
    ['user updates own loot',              USER_A, loot('user-a'), 'update', true],
    ['user updates other loot',            USER_A, loot('user-b'), 'update', false, 'not-owner'],
    ['admin deletes other loot',           ADMIN,  loot('user-a'), 'delete', true],
    ['user deletes own loot',              USER_A, loot('user-a'), 'delete', true],
    ['user deletes other loot',            USER_A, loot('user-b'), 'delete', false, 'not-owner'],
    ['loot push is wrong-action',          USER_A, loot('user-a'), 'push',   false, 'wrong-action'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── printer ───────────────────────────────────────────────────────────────────

describe('printer', () => {
  const cases: TestRow[] = [
    // read: fleet-visible (all authenticated)
    ['admin reads any printer',            ADMIN,  printer('user-a'),              'read',   true],
    ['user reads own printer',             USER_A, printer('user-a'),              'read',   true],
    ['user reads other printer',           USER_A, printer('user-b'),              'read',   true],

    // create: any authenticated user
    ['admin creates printer',              ADMIN,  printer(),                       'create', true],
    ['user creates printer',               USER_A, printer(),                       'create', true],

    // push: owner OR grantee — admins NOT exempt
    ['owner pushes to own printer',        USER_A, printer('user-a'),              'push',   true],
    ['grantee pushes to printer',          USER_B, printer('user-a', ['user-b']), 'push',   true],
    ['user pushes, not in ACL',            USER_B, printer('user-a'),              'push',   false, 'not-in-acl'],
    ['admin pushes, not in ACL',           ADMIN,  printer('user-a'),              'push',   false, 'not-in-acl'],
    ['admin pushes, no ACL list',          ADMIN,  printer('user-a', []),          'push',   false, 'not-in-acl'],
    ['admin is grantee → push allowed',    ADMIN,  printer('user-a', ['admin-1']), 'push',   true],

    // update/delete: owner only
    ['user updates own printer',           USER_A, printer('user-a'),              'update', true],
    ['user updates other printer',         USER_A, printer('user-b'),              'update', false, 'not-owner'],
    ['admin updates other printer',        ADMIN,  printer('user-a'),              'update', false, 'not-owner'],
    ['user deletes own printer',           USER_A, printer('user-a'),              'delete', true],
    ['user deletes other printer',         USER_A, printer('user-b'),              'delete', false, 'not-owner'],
    ['admin deletes other printer',        ADMIN,  printer('user-a'),              'delete', false, 'not-owner'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── slicer ────────────────────────────────────────────────────────────────────

describe('slicer', () => {
  const cases: TestRow[] = [
    ['admin reads slicer',                 ADMIN,  slicer('user-a'),              'read',   true],
    ['user reads other slicer',            USER_A, slicer('user-b'),              'read',   true],
    ['user creates slicer',                USER_A, slicer(),                       'create', true],
    ['owner pushes slicer',                USER_A, slicer('user-a'),              'push',   true],
    ['grantee pushes slicer',              USER_B, slicer('user-a', ['user-b']), 'push',   true],
    ['user pushes, not in slicer ACL',     USER_B, slicer('user-a'),              'push',   false, 'not-in-acl'],
    ['admin pushes, not in slicer ACL',    ADMIN,  slicer('user-a'),              'push',   false, 'not-in-acl'],
    ['user updates own slicer',            USER_A, slicer('user-a'),              'update', true],
    ['user updates other slicer',          USER_A, slicer('user-b'),              'update', false, 'not-owner'],
    ['admin updates other slicer',         ADMIN,  slicer('user-a'),              'update', false, 'not-owner'],
    ['user deletes own slicer',            USER_A, slicer('user-a'),              'delete', true],
    ['admin deletes other slicer',         ADMIN,  slicer('user-a'),              'delete', false, 'not-owner'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── material ──────────────────────────────────────────────────────────────────

describe('material', () => {
  const cases: TestRow[] = [
    // read: admin OR owner
    ['admin reads any material',           ADMIN,  material('user-a'), 'read',   true],
    ['user reads own material',            USER_A, material('user-a'), 'read',   true],
    ['user reads other material',          USER_A, material('user-b'), 'read',   false, 'not-owner'],

    // create: any authenticated user
    ['admin creates material',             ADMIN,  material(),          'create', true],
    ['user creates material',              USER_A, material(),          'create', true],

    // update: owner-only
    ['user updates own material',          USER_A, material('user-a'), 'update', true],
    ['user updates other material',        USER_A, material('user-b'), 'update', false, 'not-owner'],
    ['admin updates other material',       ADMIN,  material('user-a'), 'update', false, 'not-owner'],

    // delete: owner-only
    ['user deletes own material',          USER_A, material('user-a'), 'delete', true],
    ['user deletes other material',        USER_A, material('user-b'), 'delete', false, 'not-owner'],
    ['admin deletes other material',       ADMIN,  material('user-a'), 'delete', false, 'not-owner'],

    // push: wrong-action
    ['push material is wrong-action',      USER_A, material('user-a'), 'push',   false, 'wrong-action'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── watchlist_subscription ────────────────────────────────────────────────────

describe('watchlist_subscription', () => {
  const cases: TestRow[] = [
    // owner-only CRUD; admin cannot access
    ['owner reads own subscription',       USER_A, watchlistSub('user-a'), 'read',   true],
    ['owner creates subscription',         USER_A, watchlistSub('user-a'), 'create', true],
    ['owner updates own subscription',     USER_A, watchlistSub('user-a'), 'update', true],
    ['owner deletes own subscription',     USER_A, watchlistSub('user-a'), 'delete', true],
    ['user reads other subscription',      USER_A, watchlistSub('user-b'), 'read',   false, 'not-owner'],
    ['admin reads subscription',           ADMIN,  watchlistSub('user-a'), 'read',   false, 'not-owner'],
    ['admin deletes subscription',         ADMIN,  watchlistSub('user-a'), 'delete', false, 'not-owner'],
    ['push watchlist_sub is wrong-action', USER_A, watchlistSub('user-a'), 'push',   false, 'wrong-action'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── grimoire_entry ────────────────────────────────────────────────────────────

describe('grimoire_entry', () => {
  const cases: TestRow[] = [
    ['owner reads own entry',              USER_A, grimoireEntry('user-a'), 'read',   true],
    ['owner creates entry',                USER_A, grimoireEntry('user-a'), 'create', true],
    ['owner updates own entry',            USER_A, grimoireEntry('user-a'), 'update', true],
    ['owner deletes own entry',            USER_A, grimoireEntry('user-a'), 'delete', true],
    ['user reads other entry',             USER_A, grimoireEntry('user-b'), 'read',   false, 'not-owner'],
    ['admin reads grimoire entry',         ADMIN,  grimoireEntry('user-a'), 'read',   false, 'not-owner'],
    ['admin deletes grimoire entry',       ADMIN,  grimoireEntry('user-a'), 'delete', false, 'not-owner'],
    ['push grimoire entry is wrong-action',USER_A, grimoireEntry('user-a'), 'push',   false, 'wrong-action'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── user ──────────────────────────────────────────────────────────────────────

describe('user resource', () => {
  const cases: TestRow[] = [
    // read
    ['admin reads any user',               ADMIN,  userResource('user-a'), 'read',   true],
    ['user reads self',                    USER_A, userResource('user-a'), 'read',   true],
    ['user reads other user',              USER_A, userResource('user-b'), 'read',   false, 'admin-required'],

    // create
    ['admin creates user',                 ADMIN,  userResource(),         'create', true],
    ['user creates user',                  USER_A, userResource(),         'create', false, 'admin-required'],

    // update
    ['admin updates any user',             ADMIN,  userResource('user-a'), 'update', true],
    ['user updates self',                  USER_A, userResource('user-a'), 'update', true],
    ['user updates other user',            USER_A, userResource('user-b'), 'update', false, 'admin-required'],

    // delete
    ['admin deletes user',                 ADMIN,  userResource('user-a'), 'delete', true],
    ['user deletes self',                  USER_A, userResource('user-a'), 'delete', false, 'admin-required'],
    ['user deletes other user',            USER_A, userResource('user-b'), 'delete', false, 'admin-required'],

    // push: wrong-action
    ['push user is wrong-action',          USER_A, userResource('user-a'), 'push',   false, 'wrong-action'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── instance_config ───────────────────────────────────────────────────────────

describe('instance_config', () => {
  const cases: TestRow[] = [
    ['admin reads instance_config',        ADMIN,  instanceConfig(), 'read',   true],
    ['user reads instance_config',         USER_A, instanceConfig(), 'read',   true],
    ['admin updates instance_config',      ADMIN,  instanceConfig(), 'update', true],
    ['user updates instance_config',       USER_A, instanceConfig(), 'update', false, 'admin-required'],
    ['create instance_config wrong-action',USER_A, instanceConfig(), 'create', false, 'wrong-action'],
    ['delete instance_config wrong-action',USER_A, instanceConfig(), 'delete', false, 'wrong-action'],
    ['push instance_config wrong-action',  USER_A, instanceConfig(), 'push',   false, 'wrong-action'],
    ['admin create instance_config',       ADMIN,  instanceConfig(), 'create', false, 'wrong-action'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── api_key ───────────────────────────────────────────────────────────────────

describe('api_key', () => {
  const cases: TestRow[] = [
    // read
    ['admin reads any api_key',            ADMIN,  apiKey('user-a'), 'read',   true],
    ['user reads own api_key',             USER_A, apiKey('user-a'), 'read',   true],
    ['user reads other api_key',           USER_A, apiKey('user-b'), 'read',   false, 'not-owner'],

    // create own key
    ['user creates own api_key',           USER_A, apiKey('user-a'), 'create', true],
    ['user creates key with no ownerId',   USER_A, apiKey(),         'create', true],
    ['user creates key for other user',    USER_A, apiKey('user-b'), 'create', false, 'admin-required'],
    ['admin creates key for other user',   ADMIN,  apiKey('user-b'), 'create', true],

    // delete
    ['user deletes own api_key',           USER_A, apiKey('user-a'), 'delete', true],
    ['user deletes other api_key',         USER_A, apiKey('user-b'), 'delete', false, 'not-owner'],
    ['admin deletes other api_key',        ADMIN,  apiKey('user-a'), 'delete', false, 'not-owner'],

    // update/push: wrong-action
    ['update api_key is wrong-action',     USER_A, apiKey('user-a'), 'update', false, 'wrong-action'],
    ['push api_key is wrong-action',       USER_A, apiKey('user-a'), 'push',   false, 'wrong-action'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── ledger_event ──────────────────────────────────────────────────────────────

describe('ledger_event', () => {
  const cases: TestRow[] = [
    ['admin reads ledger_event',           ADMIN,  ledgerEvent(), 'read',   true],
    ['user reads ledger_event',            USER_A, ledgerEvent(), 'read',   false, 'admin-required'],
    ['create ledger_event wrong-action',   USER_A, ledgerEvent(), 'create', false, 'wrong-action'],
    ['create ledger_event admin wrong',    ADMIN,  ledgerEvent(), 'create', false, 'wrong-action'],
    ['update ledger_event wrong-action',   USER_A, ledgerEvent(), 'update', false, 'wrong-action'],
    ['delete ledger_event wrong-action',   USER_A, ledgerEvent(), 'delete', false, 'wrong-action'],
    ['push ledger_event wrong-action',     USER_A, ledgerEvent(), 'push',   false, 'wrong-action'],
    ['admin update ledger_event wrong',    ADMIN,  ledgerEvent(), 'update', false, 'wrong-action'],
    ['admin delete ledger_event wrong',    ADMIN,  ledgerEvent(), 'delete', false, 'wrong-action'],
  ];

  it.each(cases)('%s', (_desc, user, resource, action, expectedAllowed, expectedReason) => {
    const result = resolveAcl({ user, resource, action });
    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed && expectedReason) {
      expect(result.reason).toBe(expectedReason);
    }
  });
});

// ── cross-cutting: printer ACL corner cases ──────────────────────────────────

describe('printer ACL edge cases', () => {
  it('admin who is listed as grantee can push', () => {
    const result = resolveAcl({
      user: ADMIN,
      resource: printer('user-a', ['admin-1', 'user-b']),
      action: 'push',
    });
    expect(result.allowed).toBe(true);
  });

  it('grantee list is empty → deny not-in-acl', () => {
    const result = resolveAcl({
      user: USER_B,
      resource: printer('user-a', []),
      action: 'push',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('not-in-acl');
  });

  it('grantee list is undefined → deny not-in-acl (non-owner)', () => {
    const result = resolveAcl({
      user: USER_B,
      resource: { kind: 'printer', ownerId: 'user-a', id: 'p1' },
      action: 'push',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('not-in-acl');
  });

  it('owner who is also in grantees list can push (no regression)', () => {
    const result = resolveAcl({
      user: USER_A,
      resource: printer('user-a', ['user-a', 'user-b']),
      action: 'push',
    });
    expect(result.allowed).toBe(true);
  });
});

// ── cross-cutting: no role on resource edge cases ────────────────────────────

describe('owner-checking when ownerId is undefined', () => {
  it('collection with no ownerId: user update → deny not-owner', () => {
    // If resource.ownerId is undefined, isOwner returns false → not-owner
    const result = resolveAcl({
      user: USER_A,
      resource: { kind: 'collection' },
      action: 'update',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('not-owner');
  });

  it('collection with no ownerId: admin update → allow', () => {
    const result = resolveAcl({
      user: ADMIN,
      resource: { kind: 'collection' },
      action: 'update',
    });
    expect(result.allowed).toBe(true);
  });

  it('material with no ownerId: user read → deny not-owner', () => {
    const result = resolveAcl({
      user: USER_A,
      resource: { kind: 'material' },
      action: 'read',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('not-owner');
  });

  it('user resource with no id: user self-read → deny admin-required (id mismatch)', () => {
    // No id on resource means isSelf returns false
    const result = resolveAcl({
      user: USER_A,
      resource: { kind: 'user' },
      action: 'read',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('admin-required');
  });
});

// ── return type shape ─────────────────────────────────────────────────────────

describe('return type shape', () => {
  it('Allow has allowed: true and no reason field', () => {
    const result = resolveAcl({ user: ADMIN, resource: ledgerEvent(), action: 'read' });
    expect(result).toEqual({ allowed: true });
    expect('reason' in result).toBe(false);
  });

  it('Deny has allowed: false and a reason string', () => {
    const result = resolveAcl({ user: USER_A, resource: ledgerEvent(), action: 'read' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
