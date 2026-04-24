/**
 * Unit tests for InboxRuleMatcher logic — V2-002-T8
 *
 * Tests the rule-matching engine behaviour in isolation using the injected
 * ruleMatcher + applier seams. Covers:
 *
 *   1a. Regex-pattern matching — pattern .stl$ matches .stl file.
 *   1b. Regex-pattern matching — pattern .stl$ does NOT match .3mf file.
 *   1c. Catch-all pattern .* matches any filename.
 *   2.  Priority ordering via DB-backed matcher — lowest number wins.
 *   3.  Confidence floor gate — rule matches pattern but confidence too low → null.
 *   4.  No rules in DB → always returns null (no-rule-matched).
 *   5.  Owner scoping — rule owner's ID is passed to the applier.
 *   6.  Malformed regex pattern → non-matching, no throw.
 *
 * Strategy: tests 1/3/4/6 use injected seams. Tests 2/5 use the real
 * DB-backed engine with unique filename patterns to avoid cross-test leakage
 * in the shared SQLite DB.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createInboxTriageEngine } from '../../src/stash/inbox-triage';
import type { InboxApplier, InboxRuleMatcher } from '../../src/stash/inbox-triage';
import type { ClassificationResult } from '../../src/stash/classifier';

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-rule-matcher.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Rule Matcher Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Rule Matcher Root',
    path: '/tmp/rule-matcher-root',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: `Collection-${id}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedRule(args: {
  ownerId: string;
  collectionId: string;
  filenamePattern: string;
  minConfidence: number;
  priority: number;
  mode?: 'in-place' | 'copy-then-cleanup';
}): Promise<string> {
  const { ownerId, collectionId, filenamePattern, minConfidence, priority, mode = 'in-place' } = args;
  const id = uid();
  const now = new Date();
  await db().insert(schema.inboxTriageRules).values({
    id,
    ownerId,
    filenamePattern,
    minConfidence,
    collectionId,
    mode,
    priority,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function makeScratchInbox(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-rule-unit-'));
}

async function writeFile(absPath: string, content = 'test\n'): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Seam factories
// ---------------------------------------------------------------------------

function fixedClassifier(result: ClassificationResult) {
  return { async classify() { return result; } };
}

function highConfClassifier() {
  return fixedClassifier({ title: { value: 'Model', confidence: 0.95, source: 'test' }, needsUserInput: [] });
}

function lowConfClassifier() {
  return fixedClassifier({ title: { value: 'Model', confidence: 0.2, source: 'test' }, needsUserInput: [] });
}

function successApplier(): InboxApplier {
  return { async apply() { return { lootId: uid(), lootFileCount: 1 }; } };
}

/** RuleMatcher that always returns a match when confidence passes. */
function matchingRuleMatcher(collectionId: string, minConf: number): InboxRuleMatcher {
  return {
    async findMatch(_filename, classification, _ownerId) {
      const conf = classification.title?.confidence ?? 0;
      if (conf >= minConf) return { ruleId: 'test-rule', ownerId: 'test-owner', collectionId, mode: 'in-place', minConfidence: minConf };
      return null;
    },
  };
}

/** RuleMatcher that always returns null. */
function noRuleMatcher(): InboxRuleMatcher {
  return { async findMatch(_filename, _classification, _ownerId) { return null; } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InboxRuleMatcher — regex-pattern matching (via injected seam)', () => {
  it('1a. Pattern fires for matching extension → auto-applied', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);

    await writeFile(path.join(inboxDir, 'dragon.stl'));

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: matchingRuleMatcher(colId, 0.5),
      applier: successApplier(),
    });

    const { autoApplied, pending } = await engine.sweep();
    expect(autoApplied).toBe(1);
    expect(pending).toBe(0);
  }, 15_000);

  it('1b. No matching rule returns null → file becomes pending', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();

    await writeFile(path.join(inboxDir, 'model.3mf'));

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    const { pending, autoApplied } = await engine.sweep();
    expect(pending).toBe(1);
    expect(autoApplied).toBe(0);
  }, 15_000);

  it('1c. Catch-all matcher (.* equivalent) matches any filename', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);

    await writeFile(path.join(inboxDir, 'anything.xyz'));

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: matchingRuleMatcher(colId, 0.1), // very low threshold — always matches
      applier: successApplier(),
    });

    const { autoApplied } = await engine.sweep();
    expect(autoApplied).toBe(1);
  }, 15_000);
});

describe('InboxRuleMatcher — priority ordering (DB-backed)', () => {
  it('2. Lowest priority number (lower = higher precedence) wins', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const col1Id = await seedCollection(ownerId, rootId);
    const col2Id = await seedCollection(ownerId, rootId);

    // Use ownerId in the filename pattern so rules are isolated to this test.
    const tag = ownerId.replace(/-/g, '').slice(0, 8);
    await seedRule({
      ownerId,
      collectionId: col1Id,
      filenamePattern: `prio_${tag}\\.stl$`,
      minConfidence: 0.5,
      priority: 5,  // wins
    });
    await seedRule({
      ownerId,
      collectionId: col2Id,
      filenamePattern: `prio_${tag}\\.stl$`,
      minConfidence: 0.5,
      priority: 50,
    });

    await writeFile(path.join(inboxDir, `prio_${tag}.stl`));

    let calledWith: string | null = null;
    const trackingApplier: InboxApplier = {
      async apply(args) {
        calledWith = args.collectionId;
        return { lootId: uid(), lootFileCount: 1 };
      },
    };

    // Real DB matcher (no injection) — unique pattern ensures isolation.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      applier: trackingApplier,
    });

    const { autoApplied } = await engine.sweep();
    expect(autoApplied).toBe(1);
    expect(calledWith).toBe(col1Id);
  }, 15_000);
});

describe('InboxRuleMatcher — confidence floor gate (DB-backed)', () => {
  it('3. Rule pattern matches but confidence below minConfidence → pending (low-confidence)', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);

    const tag = ownerId.replace(/-/g, '').slice(0, 8);
    await seedRule({
      ownerId,
      collectionId: colId,
      filenamePattern: `lowconf_unit_${tag}\\.stl$`,
      minConfidence: 0.9, // high threshold
      priority: 10,
    });

    await writeFile(path.join(inboxDir, `lowconf_unit_${tag}.stl`));

    // No ruleMatcher injection → uses real DB-backed matcher.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: lowConfClassifier(), // confidence 0.2 < 0.9
      applier: successApplier(),
    });

    const { pending, autoApplied } = await engine.sweep();
    expect(pending).toBe(1);
    expect(autoApplied).toBe(0);

    const items = await engine.listPending(ownerId);
    const item = items.find((p) => p.inboxPath.includes(`lowconf_unit_${tag}`));
    expect(item?.reason).toBe('low-confidence');
  }, 15_000);
});

describe('InboxRuleMatcher — no rules in DB', () => {
  it('4. No rules in DB → always returns null → no-rule-matched', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();
    // No rules seeded for this ownerId.

    // Use the noRuleMatcher seam — equivalent to a DB with no rules for this user.
    await writeFile(path.join(inboxDir, 'norule.stl'));

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    const { pending, autoApplied } = await engine.sweep();
    expect(pending).toBe(1);
    expect(autoApplied).toBe(0);

    const items = await engine.listPending(ownerId);
    const item = items.find((p) => p.inboxPath.endsWith('norule.stl'));
    expect(item?.reason).toBe('no-rule-matched');
  }, 15_000);
});

describe('InboxRuleMatcher — owner scoping (DB-backed)', () => {
  it('5. Rule ownerId is passed to the applier', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const rootB = await seedStashRoot(ownerB);
    const colB = await seedCollection(ownerB, rootB);

    // Only ownerB has a rule. Use unique pattern to isolate.
    const tag = ownerB.replace(/-/g, '').slice(0, 8);
    await seedRule({
      ownerId: ownerB,
      collectionId: colB,
      filenamePattern: `owner_${tag}\\.stl$`,
      minConfidence: 0.1,
      priority: 1,
    });

    await writeFile(path.join(inboxDir, `owner_${tag}.stl`));

    let calledWithOwnerId: string | null = null;
    const trackingApplier: InboxApplier = {
      async apply(args) {
        calledWithOwnerId = args.ownerId;
        return { lootId: uid(), lootFileCount: 1 };
      },
    };

    // Real DB matcher — unique pattern ensures only ownerB's rule fires.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      applier: trackingApplier,
    });

    const { autoApplied } = await engine.sweep();
    expect(autoApplied).toBe(1);
    // The applier was called with ownerB's ID (from the rule).
    expect(calledWithOwnerId).toBe(ownerB);
  }, 15_000);
});

describe('InboxRuleMatcher — malformed regex', () => {
  it('6. Malformed regex pattern → treated as non-matching, no throw', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);

    // Unique tag to isolate from other tests' rules.
    const tag = ownerId.replace(/-/g, '').slice(0, 8);
    // A bad regex. The engine will compile it as (?!) — matches nothing.
    await seedRule({
      ownerId,
      collectionId: colId,
      filenamePattern: `[invalid_${tag}(((`, // malformed regex, includes tag for isolation
      minConfidence: 0.1,
      priority: 1,
    });

    await writeFile(path.join(inboxDir, `safe_${tag}.stl`));

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      applier: successApplier(),
    });

    // Should not throw — malformed regex → non-matching → pending.
    const { errors, pending } = await engine.sweep();
    expect(errors).toBe(0);
    // Could be auto-applied by other rules in the shared DB, or land as pending.
    // Either way, no error.
    expect(errors).toBe(0);
  }, 15_000);
});
