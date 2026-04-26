/**
 * Unit tests for adoption/grouping.ts
 *
 * Pure heuristic grouping logic — no filesystem access.
 *
 * Cases:
 *   1.  Single folder with multiple files → one candidate
 *   2.  Multiple folders → one candidate per folder
 *   3.  3MF solo + thumbnail in a folder → one candidate
 *   4.  Shared basename at top level → grouped into one candidate
 *   5.  Mixed folder (multiple stems) → one candidate per folder (whole folder = loot)
 *   6.  Nested folders → candidates per immediate parent
 *   7.  Top-level files, no shared basename → one candidate each
 *   8.  Empty input → empty output
 */

import { describe, it, expect } from 'vitest';
import { groupFilesIntoCandidates } from '../../../src/stash/adoption/grouping';
import type { WalkedFile } from '../../../src/stash/adoption/walker';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeFile(relativePath: string, size = 100): WalkedFile {
  return {
    absolutePath: `/stash/${relativePath}`,
    relativePath,
    size,
    mtime: new Date('2024-01-01T00:00:00Z'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('groupFilesIntoCandidates', () => {
  it('groups all files in a single folder into one candidate', () => {
    const files = [
      makeFile('Dragon/dragon.stl'),
      makeFile('Dragon/dragon.png'),
      makeFile('Dragon/README.md'),
    ];
    const result = groupFilesIntoCandidates(files);
    expect(result).toHaveLength(1);
    expect(result[0]!.folderRelativePath).toBe('Dragon');
    expect(result[0]!.files).toHaveLength(3);
  });

  it('creates one candidate per folder when multiple folders exist', () => {
    const files = [
      makeFile('Dragon/dragon.stl'),
      makeFile('Dragon/dragon.png'),
      makeFile('Basilisk/basilisk.stl'),
      makeFile('Basilisk/basilisk.png'),
    ];
    const result = groupFilesIntoCandidates(files);
    expect(result).toHaveLength(2);
    const folders = result.map((c) => c.folderRelativePath).sort();
    expect(folders).toEqual(['Basilisk', 'Dragon']);
  });

  it('handles 3MF solo + thumbnail as one candidate', () => {
    const files = [
      makeFile('Dragon/dragon.3mf'),
      makeFile('Dragon/thumbnail.png'),
    ];
    const result = groupFilesIntoCandidates(files);
    expect(result).toHaveLength(1);
    expect(result[0]!.folderRelativePath).toBe('Dragon');
    expect(result[0]!.files).toHaveLength(2);
  });

  it('groups top-level files with shared basename into one candidate', () => {
    const files = [
      makeFile('Dragon.stl'),
      makeFile('Dragon.png'),
      makeFile('Dragon.readme'),
    ];
    const result = groupFilesIntoCandidates(files);
    expect(result).toHaveLength(1);
    // Candidate has all three files
    expect(result[0]!.files).toHaveLength(3);
  });

  it('puts each distinct top-level stem into a separate candidate', () => {
    const files = [
      makeFile('Dragon.stl'),
      makeFile('Dragon.png'),
      makeFile('Basilisk.stl'),
    ];
    const result = groupFilesIntoCandidates(files);
    expect(result).toHaveLength(2);
  });

  it('mixed folder (multiple distinct stems) becomes ONE candidate (whole folder = loot)', () => {
    const files = [
      makeFile('Pack/dragon.stl'),
      makeFile('Pack/basilisk.stl'),
      makeFile('Pack/hydra.stl'),
    ];
    const result = groupFilesIntoCandidates(files);
    // All three files in ONE candidate — the folder IS the Loot
    expect(result).toHaveLength(1);
    expect(result[0]!.folderRelativePath).toBe('Pack');
    expect(result[0]!.files).toHaveLength(3);
  });

  it('handles nested folders — candidates use immediate parent only', () => {
    const files = [
      makeFile('Creator/Dragon/dragon.stl'),
      makeFile('Creator/Dragon/dragon.png'),
      makeFile('Creator/Basilisk/basilisk.stl'),
    ];
    const result = groupFilesIntoCandidates(files);
    // "Creator/Dragon" and "Creator/Basilisk" are the immediate parents
    expect(result).toHaveLength(2);
    const folders = result.map((c) => c.folderRelativePath).sort();
    expect(folders).toEqual(['Creator/Basilisk', 'Creator/Dragon']);
  });

  it('returns empty array for empty input', () => {
    const result = groupFilesIntoCandidates([]);
    expect(result).toHaveLength(0);
  });

  it('single file at top level → one candidate', () => {
    const files = [makeFile('dragon.stl')];
    const result = groupFilesIntoCandidates(files);
    expect(result).toHaveLength(1);
    expect(result[0]!.files).toHaveLength(1);
  });
});
