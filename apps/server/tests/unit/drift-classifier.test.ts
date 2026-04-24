/**
 * Unit tests for drift-classifier — V2-002-T5
 *
 * All tests are pure / deterministic / no I/O.
 *
 * Test cases:
 *   1. Empty FS + empty DB → no verdicts.
 *   2. Only FS entries, no DB → all 'added-externally'.
 *   3. Only DB entries, no FS → all 'removed-externally'.
 *   4. FS matches DB by path + hash → all 'matched'.
 *   5. FS path in DB but hash differs → 'content-changed'.
 *   6. FS path in DB but no FS hash present → 'matched' (can't detect content drift without hash).
 *   7. Mix of all 4 verdict kinds in one input.
 *   8. Results are sorted lexicographically by path.
 */

import { describe, it, expect } from 'vitest';
import { classifyDrift } from '../../src/stash/drift-classifier';
import type { FsEntry, DbLootFileEntry, DriftVerdict } from '../../src/stash/drift-classifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fs(path: string, hash?: string, size = 100): FsEntry {
  return { path, size, hash, mtime: new Date('2026-01-01T00:00:00Z') };
}

function db(path: string, hash: string, lootFileId = `lf-${path}`, lootId = `l-${path}`): DbLootFileEntry {
  return { path, size: 100, hash, lootFileId, lootId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyDrift', () => {
  it('1. empty FS + empty DB → no verdicts', () => {
    expect(classifyDrift([], [])).toEqual([]);
  });

  it('2. only FS entries, no DB → all added-externally', () => {
    const fsEntries: FsEntry[] = [
      fs('a/b.stl', 'hash1'),
      fs('c/d.3mf', 'hash2'),
    ];
    const result = classifyDrift(fsEntries, []);
    expect(result).toHaveLength(2);
    for (const v of result) {
      expect(v.kind).toBe('added-externally');
    }
    // Both paths present
    const paths = result.map((v) => v.path);
    expect(paths).toContain('a/b.stl');
    expect(paths).toContain('c/d.3mf');
  });

  it('3. only DB entries, no FS → all removed-externally', () => {
    const dbEntries: DbLootFileEntry[] = [
      db('a/b.stl', 'hash1'),
      db('c/d.3mf', 'hash2'),
    ];
    const result = classifyDrift([], dbEntries);
    expect(result).toHaveLength(2);
    for (const v of result) {
      expect(v.kind).toBe('removed-externally');
    }
    const paths = result.map((v) => v.path);
    expect(paths).toContain('a/b.stl');
    expect(paths).toContain('c/d.3mf');
  });

  it('4. FS matches DB by path + hash → all matched', () => {
    const hash = 'abc123';
    const result = classifyDrift([fs('x/y.stl', hash)], [db('x/y.stl', hash)]);
    expect(result).toEqual([
      { kind: 'matched', path: 'x/y.stl', lootFileId: 'lf-x/y.stl' },
    ]);
  });

  it('5. FS path in DB but hash differs → content-changed', () => {
    const fsEntry = fs('x/y.stl', 'new-hash');
    const dbEntry = db('x/y.stl', 'old-hash');
    const result = classifyDrift([fsEntry], [dbEntry]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'content-changed',
      path: 'x/y.stl',
      lootFileId: dbEntry.lootFileId,
      lootId: dbEntry.lootId,
      dbHash: 'old-hash',
    });
    // fsEntry is embedded
    const v = result[0] as Extract<DriftVerdict, { kind: 'content-changed' }>;
    expect(v.fsEntry.hash).toBe('new-hash');
  });

  it('6. FS path in DB but no FS hash → matched (cannot detect content drift)', () => {
    // FS entry has no hash — caller opted out of hash computation.
    const fsEntry = fs('x/y.stl', undefined);
    const dbEntry = db('x/y.stl', 'some-hash');
    const result = classifyDrift([fsEntry], [dbEntry]);
    expect(result).toEqual([
      { kind: 'matched', path: 'x/y.stl', lootFileId: dbEntry.lootFileId },
    ]);
  });

  it('7. mix of all four verdict kinds', () => {
    // 'matched': path in both, hashes agree
    // 'content-changed': path in both, hashes differ
    // 'added-externally': path in FS only
    // 'removed-externally': path in DB only
    const fsEntries: FsEntry[] = [
      fs('match/file.stl', 'same-hash'),
      fs('changed/file.3mf', 'new-hash'),
      fs('added/file.obj', 'added-hash'),
    ];
    const dbEntries: DbLootFileEntry[] = [
      db('match/file.stl', 'same-hash'),
      db('changed/file.3mf', 'old-hash'),
      db('removed/file.gcode', 'removed-hash'),
    ];

    const result = classifyDrift(fsEntries, dbEntries);
    expect(result).toHaveLength(4);

    const byKind = (kind: string) => result.filter((v) => v.kind === kind);
    expect(byKind('matched')).toHaveLength(1);
    expect(byKind('matched')[0]).toMatchObject({ path: 'match/file.stl' });

    expect(byKind('content-changed')).toHaveLength(1);
    expect(byKind('content-changed')[0]).toMatchObject({
      path: 'changed/file.3mf',
      dbHash: 'old-hash',
    });

    expect(byKind('added-externally')).toHaveLength(1);
    expect(byKind('added-externally')[0]).toMatchObject({ path: 'added/file.obj' });

    expect(byKind('removed-externally')).toHaveLength(1);
    expect(byKind('removed-externally')[0]).toMatchObject({ path: 'removed/file.gcode' });
  });

  it('8. results are sorted lexicographically by path', () => {
    const fsEntries: FsEntry[] = [
      fs('z/z.stl', 'h1'),
      fs('a/a.stl', 'h2'),
      fs('m/m.stl', 'h3'),
    ];
    // No DB entries — all will be 'added-externally', path sort is observable
    const result = classifyDrift(fsEntries, []);
    const paths = result.map((v) => v.path);
    expect(paths).toEqual(['a/a.stl', 'm/m.stl', 'z/z.stl']);
  });

  it('8b. sorted result includes DB-only (removed-externally) interleaved correctly', () => {
    const fsEntries: FsEntry[] = [fs('c/c.stl', 'h1')];
    const dbEntries: DbLootFileEntry[] = [
      db('a/a.stl', 'h2'),  // removed
      db('c/c.stl', 'h1'),  // matched
      db('z/z.stl', 'h3'),  // removed
    ];
    const result = classifyDrift(fsEntries, dbEntries);
    const paths = result.map((v) => v.path);
    expect(paths).toEqual(['a/a.stl', 'c/c.stl', 'z/z.stl']);
    expect(result[0].kind).toBe('removed-externally');
    expect(result[1].kind).toBe('matched');
    expect(result[2].kind).toBe('removed-externally');
  });
});
