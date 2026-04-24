/**
 * Unit tests for template-migration verdict classification — V2-002-T9
 *
 * Tests the pure `classifyVerdict` helper that maps a (current path, resolve
 * result, proposed path) triple to a MigrationVerdict. Collision detection is
 * NOT covered here — it requires cross-file state and is tested via the
 * integration test file.
 *
 * Test cases:
 *   1. unchanged — proposed path equals current path
 *   2. simple-move — proposed path differs from current path
 *   3. template-incompatible — resolve failed with missing-field
 *   4. template-incompatible — resolve failed with empty-segment
 *   5. os-incompatible — resolve failed with forbidden-character
 *   6. os-incompatible — resolve failed with path-too-long
 *   7. os-incompatible — resolve failed with segment-too-long
 *   8. os-incompatible — resolve failed with unknown-transform
 *   9. os-incompatible — resolve failed with reserved-name
 *  10. defensive unchanged — ok: true but proposedPathWithExt is null (guard path)
 */

import { describe, it, expect } from 'vitest';
import { classifyVerdict } from '../../src/stash/template-migration';

const LOOT_ID = 'loot-abc';
const FILE_ID = 'file-xyz';

// ---------------------------------------------------------------------------
// 1. unchanged
// ---------------------------------------------------------------------------

describe('classifyVerdict — unchanged', () => {
  it('returns unchanged when proposed path equals current path', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'bulka/dragon.stl',
      { ok: true, path: 'bulka/dragon' },
      'bulka/dragon.stl',
    );

    expect(verdict.kind).toBe('unchanged');
    if (verdict.kind === 'unchanged') {
      expect(verdict.lootId).toBe(LOOT_ID);
      expect(verdict.lootFileId).toBe(FILE_ID);
      expect(verdict.path).toBe('bulka/dragon.stl');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. simple-move
// ---------------------------------------------------------------------------

describe('classifyVerdict — simple-move', () => {
  it('returns simple-move when proposed path differs from current path', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'legacy/dragon.stl',
      { ok: true, path: 'bulka/dragon' },
      'bulka/dragon.stl',
    );

    expect(verdict.kind).toBe('simple-move');
    if (verdict.kind === 'simple-move') {
      expect(verdict.lootId).toBe(LOOT_ID);
      expect(verdict.lootFileId).toBe(FILE_ID);
      expect(verdict.currentPath).toBe('legacy/dragon.stl');
      expect(verdict.proposedPath).toBe('bulka/dragon.stl');
    }
  });

  it('returns simple-move for a no-extension file that changes directory', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'olddir/file',
      { ok: true, path: 'newdir/file' },
      'newdir/file', // no extension
    );

    expect(verdict.kind).toBe('simple-move');
    if (verdict.kind === 'simple-move') {
      expect(verdict.proposedPath).toBe('newdir/file');
    }
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. template-incompatible
// ---------------------------------------------------------------------------

describe('classifyVerdict — template-incompatible', () => {
  it('returns template-incompatible with missing-field reason', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'some/file.stl',
      { ok: false, reason: 'missing-field', details: "field 'creator' missing" },
      null,
    );

    expect(verdict.kind).toBe('template-incompatible');
    if (verdict.kind === 'template-incompatible') {
      expect(verdict.reason).toBe('missing-field');
      expect(verdict.lootId).toBe(LOOT_ID);
      expect(verdict.lootFileId).toBe(FILE_ID);
      expect(verdict.currentPath).toBe('some/file.stl');
    }
  });

  it('returns template-incompatible with empty-segment reason', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'some/file.stl',
      { ok: false, reason: 'empty-segment', details: 'A path segment resolved to an empty string' },
      null,
    );

    expect(verdict.kind).toBe('template-incompatible');
    if (verdict.kind === 'template-incompatible') {
      expect(verdict.reason).toBe('empty-segment');
    }
  });
});

// ---------------------------------------------------------------------------
// 5–9. os-incompatible
// ---------------------------------------------------------------------------

describe('classifyVerdict — os-incompatible', () => {
  it('returns os-incompatible with forbidden-character reason', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'some/file.stl',
      { ok: false, reason: 'forbidden-character', details: 'contains forbidden char' },
      null,
    );

    expect(verdict.kind).toBe('os-incompatible');
    if (verdict.kind === 'os-incompatible') {
      expect(verdict.reason).toBe('forbidden-character');
      expect(verdict.lootId).toBe(LOOT_ID);
      expect(verdict.lootFileId).toBe(FILE_ID);
      expect(verdict.currentPath).toBe('some/file.stl');
    }
  });

  it('returns os-incompatible with path-too-long reason', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'some/file.stl',
      { ok: false, reason: 'path-too-long', details: 'path exceeds limit' },
      null,
    );

    expect(verdict.kind).toBe('os-incompatible');
    if (verdict.kind === 'os-incompatible') {
      expect(verdict.reason).toBe('path-too-long');
    }
  });

  it('returns os-incompatible with segment-too-long reason', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'some/file.stl',
      { ok: false, reason: 'segment-too-long', details: 'segment exceeds 255 bytes' },
      null,
    );

    expect(verdict.kind).toBe('os-incompatible');
    if (verdict.kind === 'os-incompatible') {
      expect(verdict.reason).toBe('segment-too-long');
    }
  });

  it('returns os-incompatible with unknown-transform reason', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'some/file.stl',
      { ok: false, reason: 'unknown-transform', details: 'Transform "bogus" is not registered' },
      null,
    );

    expect(verdict.kind).toBe('os-incompatible');
    if (verdict.kind === 'os-incompatible') {
      expect(verdict.reason).toBe('unknown-transform');
    }
  });

  it('returns os-incompatible with reserved-name reason', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'some/file.stl',
      { ok: false, reason: 'reserved-name', details: 'CON is a Windows reserved name' },
      null,
    );

    expect(verdict.kind).toBe('os-incompatible');
    if (verdict.kind === 'os-incompatible') {
      expect(verdict.reason).toBe('reserved-name');
    }
  });
});

// ---------------------------------------------------------------------------
// 10. defensive guard: ok: true, proposedPathWithExt: null
// ---------------------------------------------------------------------------

describe('classifyVerdict — defensive unchanged guard', () => {
  it('returns unchanged when ok: true but proposedPathWithExt is null (should not happen in production)', () => {
    const verdict = classifyVerdict(
      LOOT_ID,
      FILE_ID,
      'some/file.stl',
      { ok: true, path: 'some/file' },
      null, // caller passes null — engine treats as unchanged
    );

    expect(verdict.kind).toBe('unchanged');
    if (verdict.kind === 'unchanged') {
      expect(verdict.path).toBe('some/file.stl');
    }
  });
});
