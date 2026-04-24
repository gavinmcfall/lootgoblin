/**
 * Unit tests for the indexer module — V2-002-T11
 *
 * Tests pure logic only — no DB, no filesystem.
 *
 * Scenarios:
 *   1.  buildFtsRow — title + creator + description + tags + formats from files.
 *   2.  buildFtsRow — null optional fields produce empty strings.
 *   3.  buildFtsRow — formats are lowercased + deduplicated.
 *   4.  buildFtsRow — tags array joined with spaces.
 *   5.  buildFtsRow — empty files → empty formats.
 *   6.  buildFtsRow — multiple files of same format → deduplicated in formats.
 *   10. buildFtsRow — loot with no tags (null) → empty tags string.
 *   11. pickPrimaryFile — empty array → null.
 *   12. pickPrimaryFile — 3MF preferred over STL.
 *   13. pickPrimaryFile — 3MF preferred over readme.txt regardless of id ordering.
 *   14. pickPrimaryFile — STL preferred over unknown formats.
 *   15. pickPrimaryFile — id tiebreaker when formats have equal priority.
 *   16. pickPrimaryFile — both unknown formats fall back to id tiebreaker.
 *   17. pickPrimaryFile — image formats above unknowns, below 3D formats.
 *   18. pickPrimaryFile — format column is case-insensitive.
 *
 * F3D runner behavior (throw / failed / not-found / ok) is tested at
 * integration level only — see tests/integration/indexer.test.ts. The unit
 * tests that previously covered them only asserted factory constructability,
 * not runtime mapping.
 */

import { describe, it, expect } from 'vitest';
import { buildFtsRow } from '../../src/stash/indexer';

// ---------------------------------------------------------------------------
// buildFtsRow
// ---------------------------------------------------------------------------

describe('buildFtsRow', () => {
  it('1. maps all fields correctly from loot + files', () => {
    const row = buildFtsRow(
      {
        id: 'loot-1',
        title: 'Dragon Model',
        creator: 'Alice',
        description: 'A fearsome dragon',
        tags: ['dragon', 'fantasy', 'creature'],
      },
      [{ format: '3mf' }, { format: 'stl' }],
    );
    expect(row.loot_id).toBe('loot-1');
    expect(row.title).toBe('Dragon Model');
    expect(row.creator).toBe('Alice');
    expect(row.description).toBe('A fearsome dragon');
    expect(row.tags).toBe('dragon fantasy creature');
    expect(row.formats).toContain('3mf');
    expect(row.formats).toContain('stl');
  });

  it('2. null optional fields produce empty strings', () => {
    const row = buildFtsRow(
      {
        id: 'loot-2',
        title: 'Minimal Loot',
        creator: null,
        description: null,
        tags: null,
      },
      [],
    );
    expect(row.creator).toBe('');
    expect(row.description).toBe('');
    expect(row.tags).toBe('');
    expect(row.formats).toBe('');
  });

  it('3. formats are lowercased and deduplicated', () => {
    const row = buildFtsRow(
      { id: 'loot-3', title: 'Multi', creator: null, description: null, tags: [] },
      [{ format: '3MF' }, { format: '3mf' }, { format: 'STL' }, { format: 'stl' }],
    );
    const formats = row.formats.split(' ');
    expect(formats.filter((f) => f === '3mf').length).toBe(1);
    expect(formats.filter((f) => f === 'stl').length).toBe(1);
    expect(formats.length).toBe(2);
  });

  it('4. tags array is joined with spaces', () => {
    const row = buildFtsRow(
      {
        id: 'loot-4',
        title: 'Tagged',
        creator: 'Bob',
        description: null,
        tags: ['sci-fi', 'mech', 'robot'],
      },
      [],
    );
    expect(row.tags).toBe('sci-fi mech robot');
  });

  it('5. empty files produces empty formats string', () => {
    const row = buildFtsRow(
      { id: 'loot-5', title: 'No Files', creator: null, description: null, tags: [] },
      [],
    );
    expect(row.formats).toBe('');
  });

  it('6. multiple files of same format are deduplicated', () => {
    const row = buildFtsRow(
      { id: 'loot-6', title: 'Dups', creator: null, description: null, tags: [] },
      [{ format: 'stl' }, { format: 'stl' }, { format: 'stl' }],
    );
    expect(row.formats).toBe('stl');
  });

  it('10. null tags produces empty tags string', () => {
    const row = buildFtsRow(
      { id: 'loot-10', title: 'No Tags', creator: null, description: null, tags: null },
      [],
    );
    expect(row.tags).toBe('');
  });
});

// ---------------------------------------------------------------------------
// pickPrimaryFile — format-priority selection
// ---------------------------------------------------------------------------

import { pickPrimaryFile } from '../../src/stash/indexer';

describe('pickPrimaryFile — format priority', () => {
  it('11. empty array returns null', () => {
    expect(pickPrimaryFile([])).toBeNull();
  });

  it('12. 3MF is preferred over STL', () => {
    const files = [
      { id: 'a', path: 'model.stl', format: 'stl' },
      { id: 'b', path: 'model.3mf', format: '3mf' },
    ];
    expect(pickPrimaryFile(files)?.format).toBe('3mf');
  });

  it('13. 3MF is preferred over readme.txt even when readme has lower id', () => {
    const files = [
      { id: 'a-first', path: 'readme.txt', format: 'txt' },
      { id: 'z-last', path: 'model.3mf', format: '3mf' },
    ];
    expect(pickPrimaryFile(files)?.path).toBe('model.3mf');
  });

  it('14. STL preferred over unknown format', () => {
    const files = [
      { id: 'a', path: 'notes.md', format: 'md' },
      { id: 'b', path: 'model.stl', format: 'stl' },
    ];
    expect(pickPrimaryFile(files)?.format).toBe('stl');
  });

  it('15. id tiebreaker applies when formats have equal priority', () => {
    const files = [
      { id: 'z', path: 'z.stl', format: 'stl' },
      { id: 'a', path: 'a.stl', format: 'stl' },
    ];
    expect(pickPrimaryFile(files)?.id).toBe('a');
  });

  it('16. both unknown formats fall back to id tiebreaker', () => {
    const files = [
      { id: 'z', path: 'z.xyz', format: 'xyz' },
      { id: 'a', path: 'a.abc', format: 'abc' },
    ];
    expect(pickPrimaryFile(files)?.id).toBe('a');
  });

  it('17. image formats preferred over unknowns but below 3D formats', () => {
    const files = [
      { id: 'a', path: 'a.txt', format: 'txt' },
      { id: 'b', path: 'b.png', format: 'png' },
      { id: 'c', path: 'c.stl', format: 'stl' },
    ];
    expect(pickPrimaryFile(files)?.format).toBe('stl');
  });

  it('18. format column is case-insensitive', () => {
    const files = [
      { id: 'a', path: 'a.STL', format: 'STL' },
      { id: 'b', path: 'b.txt', format: 'txt' },
    ];
    expect(pickPrimaryFile(files)?.format.toLowerCase()).toBe('stl');
  });
});

// ---------------------------------------------------------------------------
// F3D runner behavior — all exercised at integration level
// ---------------------------------------------------------------------------
//
// Unit tests for f3dRunner throw/timeout/not-found handling were removed in
// favour of integration coverage: regenerateThumbnail() pulls together DB I/O
// + filesystem I/O + runner invocation, so exercising it in isolation
// (without a real DB) would only type-check the factory — not observe the
// runtime mapping from runner outputs to DB rows.
//
// See tests/integration/indexer.test.ts for:
//   - Test 8:  f3dRunner returning { status: 'failed', error: '...' }
//   - Test 9:  f3dRunner returning { status: 'failed', error: 'f3d-not-found' }
//   - Test 16: f3dRunner that throws → engine catches + records as failed
//   - Test 17: stale thumbnail_path preserved on retry failure (Fix 2 invariant)
