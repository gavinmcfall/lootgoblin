/**
 * Integration tests for InboxTriageEngine — V2-002-T8
 *
 * Real SQLite at /tmp/lootgoblin-inbox-triage.db
 * Scratch inbox dirs at /tmp/lootgoblin-inbox-<random>/
 *
 * Test cases:
 *   1.  Drop file + no rules → pending row created, reason no-rule-matched.
 *   2.  Drop file + matching rule + high confidence → auto-applied, no pending row, Loot + LootFile inserted.
 *   3.  Drop file + matching rule + low confidence → pending row, reason low-confidence.
 *   4.  Drop file + non-matching rule → pending row, reason no-rule-matched.
 *   5.  Priority resolution — two matching rules with different priorities, lower priority wins.
 *   6.  confirmPlacement — user resolves pending row → Loot created, pending row gone.
 *   7.  dismiss — user dismisses → pending row gone, file still in inbox.
 *   8.  listPending filters by ownerId (shared inbox — currently returns all; ownerId is accepted).
 *   9.  Sweep on startup — files already in inbox get triaged.
 *   10. Watcher event — new file added after start → triaged.
 *   11. Unlink event — pending row deleted when file vanishes from inbox.
 *   12. Classifier error — provider throws for a file, engine continues + logs, pending reason rule-error.
 *   13. Applier error during auto-apply — pending row created with reason rule-error, file still in inbox.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createInboxTriageEngine } from '../../src/stash/inbox-triage';
import type { InboxApplier, InboxRuleMatcher } from '../../src/stash/inbox-triage';
import type { ClassificationResult } from '../../src/stash/classifier';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-inbox-triage.db';
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
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Inbox Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string, rootPath: string): Promise<string> {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Inbox Root',
    path: rootPath,
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
    name: `Col-${id}`,
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
  priority?: number;
  mode?: 'in-place' | 'copy-then-cleanup';
}): Promise<string> {
  const id = uid();
  const now = new Date();
  await db().insert(schema.inboxTriageRules).values({
    id,
    ownerId: args.ownerId,
    filenamePattern: args.filenamePattern,
    minConfidence: args.minConfidence,
    collectionId: args.collectionId,
    mode: args.mode ?? 'in-place',
    priority: args.priority ?? 100,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Scratch dir helpers
// ---------------------------------------------------------------------------

async function makeScratchInbox(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-inbox-'));
}

async function writeInboxFile(
  inboxDir: string,
  filename: string,
  content = 'lootgoblin inbox test\n',
): Promise<string> {
  const absPath = path.join(inboxDir, filename);
  await fsp.writeFile(absPath, content, 'utf8');
  return absPath;
}

// ---------------------------------------------------------------------------
// Classifier + applier factories
// ---------------------------------------------------------------------------

function fixedClassifier(result: ClassificationResult) {
  return { async classify() { return result; } };
}

function highConfClassifier() {
  return fixedClassifier({
    title: { value: 'Test Model', confidence: 0.95, source: 'test' },
    needsUserInput: [],
  });
}

function lowConfClassifier() {
  return fixedClassifier({
    title: { value: 'Test Model', confidence: 0.2, source: 'test' },
    needsUserInput: [],
  });
}

function throwingClassifier() {
  return {
    async classify(): Promise<ClassificationResult> {
      throw new Error('synthetic classifier error');
    },
  };
}

function successApplier(): InboxApplier {
  return { async apply() { return { lootId: uid(), lootFileCount: 1 }; } };
}

function failApplier(): InboxApplier {
  return { async apply() { return { error: 'synthetic applier error' }; } };
}

/** Applier that THROWS (not just returns { error }) — exercises the catch path. */
function throwingApplier(): InboxApplier {
  return {
    async apply() {
      throw new Error('synthetic applier throw');
    },
  };
}

/** Rule matcher that always returns a no-match (with configurable reason). */
function noRuleMatcher(
  reason: 'low-confidence' | 'no-rule-matched' = 'no-rule-matched',
): InboxRuleMatcher {
  return {
    async find(_filename, _classification, _ownerId) {
      return { kind: 'no-match', reason };
    },
  };
}

/** Rule matcher that returns a single fixed match when confidence passes. */
function fixedRuleMatcher(match: {
  collectionId: string;
  mode: 'in-place' | 'copy-then-cleanup';
  minConfidence: number;
}): InboxRuleMatcher {
  return {
    async find(_filename, classification, _ownerId) {
      const conf = classification.title?.confidence ?? 0;
      if (conf >= match.minConfidence) {
        return {
          kind: 'matched',
          match: { ruleId: 'fixed-rule', ownerId: 'test-owner', ...match },
        };
      }
      return { kind: 'no-match', reason: 'low-confidence' };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InboxTriageEngine — no rules', () => {
  it('1. Drop file + no rules → pending row, reason no-rule-matched', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();

    await writeInboxFile(inboxDir, 'model.stl');

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    const result = await engine.sweep();
    expect(result.pending).toBe(1);
    expect(result.autoApplied).toBe(0);

    const pending = await engine.listPending(ownerId);
    const item = pending.find((p) => p.inboxPath.endsWith('model.stl'));
    expect(item).toBeDefined();
    expect(item!.reason).toBe('no-rule-matched');
    expect(item!.classification.title?.value).toBe('Test Model');
  }, 15_000);
});

describe('InboxTriageEngine — auto-apply', () => {
  it('2. Drop file + matching rule + high confidence → auto-applied, no pending row, Loot + LootFile inserted', async () => {
    const inboxDir = await makeScratchInbox();
    const stashDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, stashDir);
    const colId = await seedCollection(ownerId, stashRootId);

    const filePath = await writeInboxFile(inboxDir, 'auto-apply.stl');

    // Use real applier so Loot rows get created; inject ruleMatcher for isolation.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: fixedRuleMatcher({ collectionId: colId, mode: 'in-place', minConfidence: 0.5 }),
    });

    const result = await engine.sweep();
    expect(result.autoApplied).toBe(1);
    expect(result.pending).toBe(0);

    // No pending row.
    const pending = await engine.listPending(ownerId);
    const item = pending.find((p) => p.inboxPath === filePath);
    expect(item).toBeUndefined();

    // Loot + LootFile rows created.
    const loots = await db()
      .select()
      .from(schema.loot)
      .where(eq(schema.loot.collectionId, colId));
    expect(loots.length).toBeGreaterThanOrEqual(1);

    const lootFiles = await db()
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.lootId, loots[0]!.id));
    expect(lootFiles.length).toBe(1);
  }, 30_000);

  it('3. Drop file + matching rule + low confidence → pending row, reason low-confidence (DB-backed)', async () => {
    const inboxDir = await makeScratchInbox();
    const stashDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, stashDir);
    const colId = await seedCollection(ownerId, stashRootId);

    // Unique tag so this rule only matches this test's file.
    const tag = ownerId.replace(/-/g, '').slice(0, 8);
    await seedRule({
      ownerId,
      collectionId: colId,
      filenamePattern: `lowconf_${tag}\\.stl$`,
      minConfidence: 0.9, // high threshold
      priority: 1,
    });

    await writeInboxFile(inboxDir, `lowconf_${tag}.stl`);

    // Use real DB-backed matcher (no injection) + low-confidence classifier.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: lowConfClassifier(), // confidence 0.2 < 0.9
      applier: successApplier(),
    });

    const result = await engine.sweep();
    expect(result.pending).toBe(1);
    expect(result.autoApplied).toBe(0);

    const pending = await engine.listPending(ownerId);
    const item = pending.find((p) => p.inboxPath.includes(`lowconf_${tag}`));
    expect(item?.reason).toBe('low-confidence');
  }, 15_000);

  it('4. Drop file + non-matching rule → pending row, reason no-rule-matched', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();

    await writeInboxFile(inboxDir, 'nonmatch.stl');

    // noRuleMatcher returns null → reason will be no-rule-matched.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    const result = await engine.sweep();
    expect(result.pending).toBe(1);
    expect(result.autoApplied).toBe(0);

    const pending = await engine.listPending(ownerId);
    const item = pending.find((p) => p.inboxPath.endsWith('nonmatch.stl'));
    expect(item?.reason).toBe('no-rule-matched');
  }, 15_000);
});

describe('InboxTriageEngine — priority resolution', () => {
  it('5. Two matching rules with different priorities — lower priority number wins (DB-backed)', async () => {
    const inboxDir = await makeScratchInbox();
    const stashDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, stashDir);
    const col1Id = await seedCollection(ownerId, stashRootId);
    const col2Id = await seedCollection(ownerId, stashRootId);

    // Only create rules for this specific owner — isolated by ownerId.
    const rule1Id = await seedRule({
      ownerId,
      collectionId: col1Id,
      filenamePattern: `priority-${ownerId}\\.stl$`, // unique pattern including ownerId
      minConfidence: 0.5,
      priority: 5,
    });
    const rule2Id = await seedRule({
      ownerId,
      collectionId: col2Id,
      filenamePattern: `priority-${ownerId}\\.stl$`,
      minConfidence: 0.5,
      priority: 50,
    });

    await writeInboxFile(inboxDir, `priority-${ownerId}.stl`);

    let appliedCollectionId: string | null = null;
    const trackingApplier: InboxApplier = {
      async apply(args) {
        appliedCollectionId = args.collectionId;
        return { lootId: uid(), lootFileCount: 1 };
      },
    };

    // Use the real DB-backed rule matcher (default — no injection) for this test.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      applier: trackingApplier,
      // No ruleMatcher injection → uses DB. Unique filename pattern ensures isolation.
    });

    const result = await engine.sweep();
    expect(result.autoApplied).toBe(1);
    expect(appliedCollectionId).toBe(col1Id);
    // Sanity: rule1Id is the higher-priority winner; rule2Id was seeded but did
    // not fire. Assert both IDs are non-empty so a future refactor that drops a
    // seed call is caught.
    expect(rule1Id).toBeTruthy();
    expect(rule2Id).toBeTruthy();
  }, 15_000);
});

describe('InboxTriageEngine — user interactions', () => {
  it('6. confirmPlacement — user resolves pending row → Loot created, pending row gone', async () => {
    const inboxDir = await makeScratchInbox();
    const stashDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, stashDir);
    const colId = await seedCollection(ownerId, stashRootId);

    const filePath = await writeInboxFile(inboxDir, 'confirm-me.stl');

    // No rules → file lands as pending.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(), // inject success for confirmPlacement
    });

    await engine.sweep();

    const before = await engine.listPending(ownerId);
    const pendingItem = before.find((p) => p.inboxPath === filePath);
    expect(pendingItem).toBeDefined();
    // Before confirmPlacement, the item must be sitting with the expected
    // no-rule-matched reason from the noRuleMatcher seam.
    expect(pendingItem!.reason).toBe('no-rule-matched');

    const result = await engine.confirmPlacement({
      pendingId: pendingItem!.id,
      ownerId,
      collectionId: colId,
      mode: 'in-place',
    });

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.lootId).toBeTruthy();
    }

    const after = await engine.listPending(ownerId);
    const stillPending = after.find((p) => p.inboxPath === filePath);
    expect(stillPending).toBeUndefined();
  }, 15_000);

  it('7. dismiss — pending row gone, file still in inbox', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();

    const filePath = await writeInboxFile(inboxDir, 'dismiss-me.stl');

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    await engine.sweep();

    const before = await engine.listPending(ownerId);
    const pendingItem = before.find((p) => p.inboxPath === filePath);
    expect(pendingItem).toBeDefined();

    await engine.dismiss(pendingItem!.id, ownerId);

    const after = await engine.listPending(ownerId);
    const stillPending = after.find((p) => p.inboxPath === filePath);
    expect(stillPending).toBeUndefined();

    // File still exists in inbox.
    expect(fs.existsSync(filePath)).toBe(true);
  }, 15_000);

  it('8. listPending accepts ownerId (shared inbox — returns all pending)', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerA = await seedUser();
    const ownerB = await seedUser();

    await writeInboxFile(inboxDir, 'shared-inbox.stl');

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    await engine.sweep();

    // Both owners should see the item (shared inbox, no owner FK).
    const pendingA = await engine.listPending(ownerA);
    const pendingB = await engine.listPending(ownerB);
    const countA = pendingA.filter((p) => p.inboxPath.endsWith('shared-inbox.stl')).length;
    const countB = pendingB.filter((p) => p.inboxPath.endsWith('shared-inbox.stl')).length;
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  }, 15_000);
});

describe('InboxTriageEngine — sweep on startup', () => {
  it('9. Direct sweep covers pre-existing files in inbox', async () => {
    const inboxDir = await makeScratchInbox();

    // Write files BEFORE creating engine.
    await writeInboxFile(inboxDir, 'pre-existing-1.stl');
    await writeInboxFile(inboxDir, 'pre-existing-2.stl');

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    const result = await engine.sweep();
    expect(result.pending + result.autoApplied).toBe(2);
  }, 15_000);
});

describe('InboxTriageEngine — watcher integration', () => {
  it('10. Watcher event — new file added after start → triaged', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      stabilityThresholdMs: 100,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    await engine.start();

    try {
      // Add file AFTER start.
      const filePath = path.join(inboxDir, 'watcher-add.stl');
      await fsp.writeFile(filePath, 'watcher test\n');

      // Poll until pending appears.
      const startMs = Date.now();
      let found = false;
      while (Date.now() - startMs < 10_000) {
        const pending = await engine.listPending(ownerId);
        if (pending.some((p) => p.inboxPath === filePath)) {
          found = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(found, 'File should appear as pending after watcher fires').toBe(true);
    } finally {
      await engine.stop();
    }
  }, 30_000);

  it('11. Unlink event — pending row deleted when file vanishes from inbox', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();

    const filePath = await writeInboxFile(inboxDir, 'will-be-deleted.stl');

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      stabilityThresholdMs: 100,
      classifier: highConfClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    await engine.start();

    try {
      // File was present before start → sweep during start() triages it → pending.
      const afterStart = await engine.listPending(ownerId);
      const item = afterStart.find((p) => p.inboxPath === filePath);
      expect(item).toBeDefined();

      // Delete the file.
      await fsp.unlink(filePath);

      // Poll until pending row is removed.
      const startMs = Date.now();
      let gone = false;
      while (Date.now() - startMs < 10_000) {
        const pending = await engine.listPending(ownerId);
        if (!pending.some((p) => p.inboxPath === filePath)) {
          gone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(gone, 'Pending row should be removed after unlink').toBe(true);
    } finally {
      await engine.stop();
    }
  }, 30_000);
});

describe('InboxTriageEngine — error handling', () => {
  it('12. Classifier error — provider throws, engine continues + logs, file triaged without error count', async () => {
    const inboxDir = await makeScratchInbox();
    const ownerId = await seedUser();

    await writeInboxFile(inboxDir, 'classifier-error.stl');

    // Classifier throws → fallback classification has no title.confidence
    // (defaults to 0). The defaultConfidenceFloor (0.75) trips BEFORE the
    // rule matcher is called, so the reason is 'low-confidence'.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: throwingClassifier(),
      ruleMatcher: noRuleMatcher(),
      applier: successApplier(),
    });

    // Should NOT throw — classifier error is caught, file lands as pending.
    const result = await engine.sweep();
    expect(result.errors).toBe(0);
    expect(result.pending).toBe(1);

    const pending = await engine.listPending(ownerId);
    const item = pending.find((p) => p.inboxPath.endsWith('classifier-error.stl'));
    expect(item).toBeDefined();
    expect(item!.reason).toBe('low-confidence');
  }, 15_000);

  it('13. Applier error during auto-apply → pending row with reason rule-error, file still in inbox', async () => {
    const inboxDir = await makeScratchInbox();
    const stashDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, stashDir);
    const colId = await seedCollection(ownerId, stashRootId);

    const filePath = await writeInboxFile(inboxDir, 'applier-error.stl');

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: fixedRuleMatcher({ collectionId: colId, mode: 'in-place', minConfidence: 0.5 }),
      applier: failApplier(),
    });

    const result = await engine.sweep();
    expect(result.autoApplied).toBe(0);
    expect(result.pending).toBe(1);

    const pending = await engine.listPending(ownerId);
    const item = pending.find((p) => p.inboxPath === filePath);
    expect(item?.reason).toBe('rule-error');

    // File still in inbox.
    expect(fs.existsSync(filePath)).toBe(true);
  }, 15_000);

  it('13b. Applier THROWS during auto-apply → catch path creates pending row with reason rule-error', async () => {
    const inboxDir = await makeScratchInbox();
    const stashDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, stashDir);
    const colId = await seedCollection(ownerId, stashRootId);

    const filePath = await writeInboxFile(inboxDir, 'applier-throw.stl');

    // Sibling of test 13 — failApplier returns { error }, throwingApplier
    // raises. Both paths must land the file as pending/rule-error.
    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      classifier: highConfClassifier(),
      ruleMatcher: fixedRuleMatcher({ collectionId: colId, mode: 'in-place', minConfidence: 0.5 }),
      applier: throwingApplier(),
    });

    const result = await engine.sweep();
    expect(result.autoApplied).toBe(0);
    expect(result.pending).toBe(1);

    const pending = await engine.listPending(ownerId);
    const item = pending.find((p) => p.inboxPath === filePath);
    expect(item?.reason).toBe('rule-error');

    // File still in inbox (applier never got to move it).
    expect(fs.existsSync(filePath)).toBe(true);
  }, 15_000);
});

describe('InboxTriageEngine — defaultConfidenceFloor guardrail', () => {
  it('14. classification below floor → skip rule eval, pending with low-confidence', async () => {
    // Classifier reports 0.5 (above rule min 0.3, below floor 0.75).
    // Without the floor, the fixedRuleMatcher would match and auto-apply.
    // With the floor, the engine skips rule evaluation entirely.
    const inboxDir = await makeScratchInbox();
    const stashDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, stashDir);
    const colId = await seedCollection(ownerId, stashRootId);

    const filePath = await writeInboxFile(inboxDir, 'floor-test.stl');

    const midConfClassifier = fixedClassifier({
      title: { value: 'Mid Confidence', confidence: 0.5, source: 'test' },
      needsUserInput: [],
    });

    let applierCalled = false;
    const spyApplier: InboxApplier = {
      async apply() {
        applierCalled = true;
        return { lootId: uid(), lootFileCount: 1 };
      },
    };

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      defaultConfidenceFloor: 0.75,
      classifier: midConfClassifier,
      // A rule that would match if reached — but the floor trips first.
      ruleMatcher: fixedRuleMatcher({ collectionId: colId, mode: 'in-place', minConfidence: 0.3 }),
      applier: spyApplier,
    });

    const result = await engine.sweep();
    expect(result.autoApplied).toBe(0);
    expect(result.pending).toBe(1);
    expect(applierCalled).toBe(false);

    const pending = await engine.listPending(ownerId);
    const item = pending.find((p) => p.inboxPath === filePath);
    expect(item?.reason).toBe('low-confidence');
  }, 15_000);

  it('15. explicit floor=0 disables the guardrail — rule eval runs as usual', async () => {
    const inboxDir = await makeScratchInbox();
    const stashDir = await makeScratchInbox();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, stashDir);
    const colId = await seedCollection(ownerId, stashRootId);

    await writeInboxFile(inboxDir, 'no-floor.stl');

    const midConfClassifier = fixedClassifier({
      title: { value: 'Mid Confidence', confidence: 0.5, source: 'test' },
      needsUserInput: [],
    });

    const engine = createInboxTriageEngine({
      inboxPath: inboxDir,
      dbUrl: DB_URL,
      defaultConfidenceFloor: 0, // disabled
      classifier: midConfClassifier,
      ruleMatcher: fixedRuleMatcher({ collectionId: colId, mode: 'in-place', minConfidence: 0.3 }),
      applier: successApplier(),
    });

    const result = await engine.sweep();
    expect(result.autoApplied).toBe(1);
    expect(result.pending).toBe(0);

    // Sanity — ownerId is used by listPending signature (no effect today).
    const stillPending = await engine.listPending(ownerId);
    expect(stillPending.find((p) => p.inboxPath.endsWith('no-floor.stl'))).toBeUndefined();
  }, 15_000);
});
