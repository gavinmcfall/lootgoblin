/**
 * Unit tests for the folder-pattern classifier provider — V2-002-T6
 *
 * Pure path heuristics — no filesystem I/O.
 *
 * Test scenarios:
 *   1. "Creator/ModelName/" → creator 0.6, title 0.6.
 *   2. "Creator/ModelName/files/" → creator not emitted (files segment triggers h2).
 *   3. "ModelName/files/" → title from ModelName at 0.5.
 *   4. Single segment → title at 0.4 (fallback).
 *   5. Missing folderRelativePath → empty result.
 *   6. "." as folderRelativePath → empty result.
 *   7. Deep path "Creator/ModelName/subdir/extra/" → Creator/ModelName pattern wins.
 *   8. "Creator/3D Files/" → 3D Files treated as file-holder, title not set.
 *   9. "Creator/STL/" → STL treated as file-holder.
 */

import { describe, it, expect } from 'vitest';
import { createFolderPatternProvider } from '../../../src/stash/classifier-providers/folder-pattern';
import type { ClassifierInput } from '../../../src/stash/classifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(folderRelativePath?: string): ClassifierInput {
  return {
    files: [
      {
        absolutePath: '/stash/model.stl',
        relativePath: 'model.stl',
        size: 100,
        mtime: new Date(),
      },
    ],
    folderRelativePath,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createFolderPatternProvider', () => {
  it('1. "Creator/ModelName" → creator 0.6, title 0.6', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput('Alice/Castle Wall'));

    expect(result.creator).toEqual({ value: 'Alice', confidence: 0.6 });
    expect(result.title).toEqual({ value: 'Castle Wall', confidence: 0.6 });
  });

  it('1b. trailing slash is normalised correctly', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput('Alice/Dragon Head/'));

    expect(result.creator?.value).toBe('Alice');
    expect(result.title?.value).toBe('Dragon Head');
  });

  it('2. "Creator/files/" → second segment is file-holder, triggers h2', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput('Alice/files'));

    // "files" is a file-holder → heuristic 1 disqualified
    // heuristic 2: last segment "files" → title from previous segment "Alice"
    expect(result.title?.value).toBe('Alice');
    expect(result.title?.confidence).toBe(0.5);
    // creator should NOT be emitted from this path
    expect(result.creator).toBeUndefined();
  });

  it('3. "ModelName/files" → title from ModelName at 0.5', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput('Castle Wall/files'));

    expect(result.title).toEqual({ value: 'Castle Wall', confidence: 0.5 });
    expect(result.creator).toBeUndefined();
  });

  it('4. Single segment "ModelName" → title at 0.4 fallback', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput('Castle Wall'));

    expect(result.title).toEqual({ value: 'Castle Wall', confidence: 0.4 });
    expect(result.creator).toBeUndefined();
  });

  it('5. No folderRelativePath → empty result', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput(undefined));
    expect(result).toEqual({});
  });

  it('6. "." as folderRelativePath → empty result', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput('.'));
    expect(result).toEqual({});
  });

  it('7. Deep path "Creator/ModelName/subdir" → Creator/ModelName pattern wins', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput('Alice/Castle Wall/extra'));

    // normalised = ['Alice', 'Castle Wall', 'extra']
    // first segment 'Alice', second 'Castle Wall' — not a file-holder → pattern 1
    expect(result.creator?.value).toBe('Alice');
    expect(result.title?.value).toBe('Castle Wall');
  });

  it('8. "Creator/3D Files" → 3D Files treated as file-holder; falls to h2 title from creator', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput('Alice/3d files'));

    // heuristic 2: last segment is "3d files" (file-holder), title = 'Alice'
    expect(result.title?.value).toBe('Alice');
    expect(result.title?.confidence).toBe(0.5);
    expect(result.creator).toBeUndefined();
  });

  it('9. "ModelName/STL" → STL treated as file-holder, title from ModelName', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput('Dragon Head/stl'));

    expect(result.title?.value).toBe('Dragon Head');
    expect(result.title?.confidence).toBe(0.5);
  });

  it('10. Empty folderRelativePath → empty result', async () => {
    const provider = createFolderPatternProvider();
    const result = await provider.classify(makeInput(''));
    expect(result).toEqual({});
  });
});
