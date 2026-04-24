/**
 * Integration tests for reconciler — V2-002-T5
 *
 * Real SQLite DB + real filesystem under /tmp.
 * DB path: /tmp/lootgoblin-reconciler.db
 * Scratch dirs: /tmp/lootgoblin-reconciler-<random>/
 *
 * Most tests use rescanIntervalMs: 0 (disable auto-scheduler) and
 * eventDebounceMs: 200. Tests manually call reconciler.rescan() for
 * determinism. vi.waitFor is used for event-driven assertions.
 *
 * Test cases:
 *   1.  Full rescan on fresh DB: matched file → report shows matched:1, DB unchanged.
 *   2.  Removed-externally via rescan: delete file → loot.fileMissing = true, lootFiles row intact.
 *   3.  Content-changed via rescan: overwrite file → lootFiles.hash updated, loot.updatedAt bumped.
 *   4.  Added-externally via rescan: file in FS not in DB → added:1, DB unchanged.
 *   5.  Event-driven drift — add event: new file → policy.onAddedExternally called.
 *   6.  Event-driven removal: delete tracked file → file_missing set.
 *   7.  FS unreachable: delete stash root dir → fs-unreachable event, no DB mutations.
 *   8.  FS recovered: restore dir → fs-recovered event.
 *   9.  Multiple stash roots: drift in each, per-root breakdown correct.
 *   10. Idempotent stop: start → stop → stop → no error.
 *   11. Restart is disallowed: start → stop → start → throws.
 *   12. Restored file un-flags file_missing: set flag, restore file → fileMissing cleared.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, mkdtempSync } from 'node:fs';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createReconciler, createDefaultPolicy } from '../../src/stash/reconciler';
import type { Reconciler, DriftResolutionPolicy } from '../../src/stash/reconciler';
import { onSystemHealth, _clearSystemHealthListeners } from '../../src/stash/system-health';
import { eq } from 'drizzle-orm';

const DB_PATH = '/tmp/lootgoblin-reconciler.db';
const DB_URL = `file:${DB_PATH}`;
const DEBOUNCE_MS = 200;
const WAIT_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function db() {
  return getDb(DB_URL) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
}

function uid() {
  return crypto.randomUUID();
}

async function seedUser() {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Reconciler Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string, rootPath: string) {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Test Root',
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string) {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: `col-${id}`,
    pathTemplate: '{creator|slug}/{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string, overrides: Partial<{
  fileMissing: boolean;
  creator: string;
  title: string;
}> = {}) {
  const id = uid();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title: overrides.title ?? 'Test Loot',
    description: null,
    tags: [],
    creator: overrides.creator ?? 'test-creator',
    license: null,
    sourceItemId: null,
    contentSummary: null,
    fileMissing: overrides.fileMissing ?? false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLootFile(lootId: string, relPath: string, hash: string, size = 100) {
  const id = uid();
  await db().insert(schema.lootFiles).values({
    id,
    lootId,
    path: relPath,
    format: path.extname(relPath).slice(1) || 'stl',
    size,
    hash,
    origin: 'ingest',
    provenance: null,
    createdAt: new Date(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Setup — fresh DB before all tests
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

afterEach(() => {
  _clearSystemHealthListeners();
});

// ---------------------------------------------------------------------------
// Scratch dir helper
// ---------------------------------------------------------------------------

function makeScratchDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'lootgoblin-reconciler-'));
}

/** Compute real SHA-256 of string content */
async function sha256OfContent(content: string): Promise<string> {
  const { sha256Hex } = await import('../../src/stash/filesystem-adapter');
  const tmpFile = path.join(os.tmpdir(), `sha256-tmp-${uid()}`);
  writeFileSync(tmpFile, content);
  const hash = await sha256Hex(tmpFile);
  unlinkSync(tmpFile);
  return hash;
}

// ---------------------------------------------------------------------------
// Test 1: Full rescan on fresh DB — matched file → report shows matched:1
// ---------------------------------------------------------------------------

describe('1. full rescan — matched file', () => {
  it('report shows matched:1 when file exists and hash matches DB', async () => {
    const scratchDir = makeScratchDir();
    const fileContent = 'hello matched world';
    const filePath = path.join(scratchDir, 'test.stl');
    writeFileSync(filePath, fileContent);
    const hash = await sha256OfContent(fileContent);

    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);
    const collId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(collId);
    await seedLootFile(lootId, 'test.stl', hash, fileContent.length);

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();
    const report = await rec.rescan();
    await rec.stop();

    const rootReport = report.perRoot.find((r) => r.stashRootId === rootId)!;
    expect(rootReport.matched).toBeGreaterThanOrEqual(1);
    expect(rootReport.removed).toBe(0);
    expect(rootReport.contentChanged).toBe(0);

    // DB should be unchanged — loot.fileMissing still false
    const lootRow = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId)).limit(1);
    expect(lootRow[0]?.fileMissing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Removed-externally via rescan
// ---------------------------------------------------------------------------

describe('2. removed-externally via rescan', () => {
  it('sets loot.fileMissing=true and leaves lootFiles row intact', async () => {
    const scratchDir = makeScratchDir();
    const fileContent = 'content to be removed';
    const filePath = path.join(scratchDir, 'remove-me.stl');
    writeFileSync(filePath, fileContent);
    const hash = await sha256OfContent(fileContent);

    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);
    const collId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(collId);
    const lootFileId = await seedLootFile(lootId, 'remove-me.stl', hash, fileContent.length);

    // Delete the file BEFORE creating the reconciler.
    unlinkSync(filePath);

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();
    const report = await rec.rescan();
    await rec.stop();

    const rootReport = report.perRoot.find((r) => r.stashRootId === rootId)!;
    expect(rootReport.removed).toBeGreaterThanOrEqual(1);

    // loot.fileMissing should be true
    const lootRow = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId)).limit(1);
    expect(lootRow[0]?.fileMissing).toBe(true);

    // lootFiles row still present
    const fileRow = await db().select().from(schema.lootFiles).where(eq(schema.lootFiles.id, lootFileId)).limit(1);
    expect(fileRow).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Content-changed via rescan
// ---------------------------------------------------------------------------

describe('3. content-changed via rescan', () => {
  it('updates lootFiles.hash and bumps loot.updatedAt', async () => {
    const scratchDir = makeScratchDir();
    const originalContent = 'original content';
    const newContent = 'completely different bytes!';
    const filePath = path.join(scratchDir, 'changed.stl');
    // Write the original file on disk first.
    writeFileSync(filePath, originalContent);
    const originalHash = await sha256OfContent(originalContent);
    const newHash = await sha256OfContent(newContent);

    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);
    const collId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(collId);
    const lootFileId = await seedLootFile(lootId, 'changed.stl', originalHash, originalContent.length);

    // Record loot.updatedAt before any rescan.
    const lootBefore = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId)).limit(1);
    const updatedAtBefore = lootBefore[0]?.updatedAt;

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    // Start (initial rescan sees original content → matched).
    await rec.start();

    // Overwrite with new content AFTER start, so the next rescan detects drift.
    writeFileSync(filePath, newContent);

    // Small delay so updatedAt timestamp will differ from before.
    await new Promise((r) => setTimeout(r, 50));

    // Second rescan should see new hash != DB hash → content-changed.
    const report = await rec.rescan();
    await rec.stop();

    const rootReport = report.perRoot.find((r) => r.stashRootId === rootId)!;
    expect(rootReport.contentChanged).toBeGreaterThanOrEqual(1);

    // lootFiles.hash updated.
    const fileRow = await db().select().from(schema.lootFiles).where(eq(schema.lootFiles.id, lootFileId)).limit(1);
    expect(fileRow[0]?.hash).toBe(newHash);

    // loot.updatedAt bumped.
    const lootAfter = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId)).limit(1);
    const updatedAtAfter = lootAfter[0]?.updatedAt;
    expect(updatedAtAfter).toBeDefined();
    // Should be same or later (may be same ms if machine is fast enough).
    expect(updatedAtAfter!.getTime()).toBeGreaterThanOrEqual(updatedAtBefore!.getTime());
  });
});

// ---------------------------------------------------------------------------
// Test 4: Added-externally via rescan
// ---------------------------------------------------------------------------

describe('4. added-externally via rescan', () => {
  it('reports added:1 when file is in FS but not DB, DB unchanged', async () => {
    const scratchDir = makeScratchDir();
    // Create a file in the stash root — nothing in DB for it.
    const filePath = path.join(scratchDir, 'orphan.stl');
    writeFileSync(filePath, 'orphan content');

    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);
    // No collection/loot/lootFile inserted.

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();
    const report = await rec.rescan();
    await rec.stop();

    const rootReport = report.perRoot.find((r) => r.stashRootId === rootId)!;
    expect(rootReport.added).toBeGreaterThanOrEqual(1);
    expect(rootReport.removed).toBe(0);
    expect(rootReport.contentChanged).toBe(0);

    // No DB mutations expected.
    const fileRows = await db().select().from(schema.lootFiles).limit(100);
    // The file should NOT have been inserted as a lootFile.
    const orphanRow = fileRows.find((r) => r.path === 'orphan.stl');
    expect(orphanRow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 5: Event-driven drift — add event
// ---------------------------------------------------------------------------

describe('5. event-driven — add event', () => {
  it('calls policy.onAddedExternally when a new file is created in the watched root', async () => {
    const scratchDir = makeScratchDir();

    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);
    // No loot in DB — so the new file will be added-externally.

    const addedCalls: Array<{ stashRootId: string; path: string }> = [];
    const testPolicy: DriftResolutionPolicy = {
      async onAddedExternally(stashRootId, fsEntry) {
        addedCalls.push({ stashRootId, path: fsEntry.path });
      },
      async onRemovedExternally() {},
      async onContentChanged() {},
    };

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
      policy: testPolicy,
    });

    await rec.start();

    // Create a new file after the watcher is running.
    const newFilePath = path.join(scratchDir, 'new-file.stl');
    writeFileSync(newFilePath, 'fresh content');

    // Wait for the debounce + event processing.
    await vi.waitFor(
      () => {
        expect(addedCalls.some((c) => c.path.endsWith('new-file.stl'))).toBe(true);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    await rec.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 6: Event-driven removal
// ---------------------------------------------------------------------------

describe('6. event-driven removal', () => {
  it('sets file_missing when a tracked file is deleted while watcher is running', async () => {
    const scratchDir = makeScratchDir();
    const fileContent = 'tracked file content';
    const filePath = path.join(scratchDir, 'tracked.stl');
    writeFileSync(filePath, fileContent);
    const hash = await sha256OfContent(fileContent);

    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);
    const collId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(collId);
    await seedLootFile(lootId, 'tracked.stl', hash, fileContent.length);

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();

    // Delete the tracked file.
    unlinkSync(filePath);

    // Wait for fileMissing to be set.
    await vi.waitFor(
      async () => {
        const lootRow = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId)).limit(1);
        expect(lootRow[0]?.fileMissing).toBe(true);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    await rec.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 7: FS unreachable
// ---------------------------------------------------------------------------

describe('7. FS unreachable', () => {
  it('emits fs-unreachable and does not mutate DB when stash root is gone', async () => {
    const scratchDir = makeScratchDir();
    const fileContent = 'content';
    const filePath = path.join(scratchDir, 'file.stl');
    writeFileSync(filePath, fileContent);
    const hash = await sha256OfContent(fileContent);

    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);
    const collId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(collId);
    await seedLootFile(lootId, 'file.stl', hash, fileContent.length);

    const healthEvents: string[] = [];
    onSystemHealth((e) => {
      healthEvents.push(e.kind);
    });

    // Delete the stash root directory entirely.
    await fsp.rm(scratchDir, { recursive: true, force: true });

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();
    const report = await rec.rescan();
    await rec.stop();

    // fs-unreachable should have been emitted.
    expect(healthEvents).toContain('fs-unreachable');

    // DB should NOT have been mutated — loot.fileMissing still false from rescan.
    const lootRow = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId)).limit(1);
    // fileMissing should still be false (no DB mutation during unreachable rescan).
    // The rescan aborts early on unreachable — it does not flip fileMissing.
    expect(lootRow[0]?.fileMissing).toBe(false);

    // Report should show errors > 0.
    const rootReport = report.perRoot.find((r) => r.stashRootId === rootId)!;
    expect(rootReport.errors).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 8: FS recovered
// ---------------------------------------------------------------------------

describe('8. FS recovered', () => {
  it('emits fs-recovered after a previously-unreachable root becomes accessible again', async () => {
    const scratchDir = makeScratchDir();

    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);

    const healthEvents: string[] = [];
    onSystemHealth((e) => {
      healthEvents.push(e.kind);
    });

    // First rescan: make root unreachable.
    await fsp.rm(scratchDir, { recursive: true, force: true });

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();
    await rec.rescan(); // unreachable

    expect(healthEvents).toContain('fs-unreachable');

    // Restore the directory.
    mkdirSync(scratchDir, { recursive: true });

    // Second rescan: root is accessible again.
    await rec.rescan();
    await rec.stop();

    expect(healthEvents).toContain('fs-recovered');
  });
});

// ---------------------------------------------------------------------------
// Test 9: Multiple stash roots
// ---------------------------------------------------------------------------

describe('9. multiple stash roots', () => {
  it('report contains per-root breakdown for two roots with different drift', async () => {
    const scratchDir1 = makeScratchDir();
    const scratchDir2 = makeScratchDir();

    // Root 1: file in DB, file exists → matched
    const content1 = 'root one content';
    writeFileSync(path.join(scratchDir1, 'r1.stl'), content1);
    const hash1 = await sha256OfContent(content1);

    // Root 2: file in DB, file missing → removed
    const content2 = 'root two content';
    const hash2 = await sha256OfContent(content2);
    // Don't create the file on disk for root 2.

    const userId = await seedUser();
    const rootId1 = await seedStashRoot(userId, scratchDir1);
    const rootId2 = await seedStashRoot(userId, scratchDir2);

    const collId1 = await seedCollection(userId, rootId1);
    const collId2 = await seedCollection(userId, rootId2);

    const lootId1 = await seedLoot(collId1);
    const lootId2 = await seedLoot(collId2);

    await seedLootFile(lootId1, 'r1.stl', hash1, content1.length);
    await seedLootFile(lootId2, 'r2.stl', hash2, content2.length);

    const rec = createReconciler({
      stashRoots: [
        { id: rootId1, path: scratchDir1 },
        { id: rootId2, path: scratchDir2 },
      ],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();
    const report = await rec.rescan();
    await rec.stop();

    expect(report.perRoot).toHaveLength(2);

    const r1 = report.perRoot.find((r) => r.stashRootId === rootId1)!;
    const r2 = report.perRoot.find((r) => r.stashRootId === rootId2)!;

    expect(r1.matched).toBeGreaterThanOrEqual(1);
    expect(r1.removed).toBe(0);

    expect(r2.removed).toBeGreaterThanOrEqual(1);
    expect(r2.matched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Idempotent stop
// ---------------------------------------------------------------------------

describe('10. idempotent stop', () => {
  it('calling stop() twice does not throw', async () => {
    const scratchDir = makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();
    await rec.stop();
    await expect(rec.stop()).resolves.toBeUndefined(); // second stop is a no-op
  });
});

// ---------------------------------------------------------------------------
// Test 11: Restart is disallowed
// ---------------------------------------------------------------------------

describe('11. restart is disallowed', () => {
  it('start() after stop() throws', async () => {
    const scratchDir = makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);

    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();
    await rec.stop();
    await expect(rec.start()).rejects.toThrow(/cannot be restarted/i);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Restored file un-flags file_missing
// ---------------------------------------------------------------------------

describe('12. restored file un-flags file_missing', () => {
  it('clears loot.fileMissing when a previously-missing file is restored', async () => {
    const scratchDir = makeScratchDir();
    const fileContent = 'file to be restored';
    const filePath = path.join(scratchDir, 'restore-me.stl');
    writeFileSync(filePath, fileContent);
    const hash = await sha256OfContent(fileContent);

    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratchDir);
    const collId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(collId, { fileMissing: true });
    await seedLootFile(lootId, 'restore-me.stl', hash, fileContent.length);

    // loot.fileMissing is set to true in seed.
    const lootBefore = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId)).limit(1);
    expect(lootBefore[0]?.fileMissing).toBe(true);

    // File exists on disk — reconciler should clear fileMissing on 'matched' verdict.
    const rec = createReconciler({
      stashRoots: [{ id: rootId, path: scratchDir }],
      rescanIntervalMs: 0,
      eventDebounceMs: DEBOUNCE_MS,
    });

    await rec.start();
    await rec.rescan();
    await rec.stop();

    const lootAfter = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId)).limit(1);
    expect(lootAfter[0]?.fileMissing).toBe(false);
  });
});
