/**
 * Unit tests for the filename classifier provider — V2-002-T6
 *
 * Pure string heuristics — no filesystem I/O needed.
 * Paths are constructed as ClassifierInput without reading real files.
 *
 * Test scenarios:
 *   1. "{creator} - {title}.ext" pattern → creator 0.5, title 0.5.
 *   2. "{title} by {creator}.ext" pattern → creator 0.5, title 0.5.
 *   3. "{title} v{version}.ext" → title 0.5 (version discarded).
 *   4. Fallback: plain basename → title 0.3.
 *   5. Multiple files — primary file (non-stub) selected for pattern matching.
 *   6. All stub files — falls back to first file's basename.
 *   7. Empty files array → empty result.
 *   8. Version pattern with decimals e.g. "v2.3".
 *   9. "{creator} - {title}" with multiple words in creator.
 */

import { describe, it, expect } from 'vitest';
import { createFilenameProvider } from '../../../src/stash/classifier-providers/filename';
import type { ClassifierInput } from '../../../src/stash/classifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(relativePaths: string[]): ClassifierInput {
  return {
    files: relativePaths.map((rp) => ({
      absolutePath: `/stash/${rp}`,
      relativePath: rp,
      size: 100,
      mtime: new Date(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createFilenameProvider', () => {
  it('1. "Creator - Title.stl" → creator 0.5, title 0.5', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['Alice - Castle Wall.stl']));

    expect(result.title).toEqual({ value: 'Castle Wall', confidence: 0.5 });
    expect(result.creator).toEqual({ value: 'Alice', confidence: 0.5 });
  });

  it('1b. "Creator Name - Title With Words.3mf" → correct split', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['Some Designer - Dragon Head V2.3mf']));

    expect(result.title?.value).toBe('Dragon Head V2');
    expect(result.creator?.value).toBe('Some Designer');
  });

  it('2. "Title by Creator.stl" → creator 0.5, title 0.5', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['Castle Wall by Alice.stl']));

    expect(result.title).toEqual({ value: 'Castle Wall', confidence: 0.5 });
    expect(result.creator).toEqual({ value: 'Alice', confidence: 0.5 });
  });

  it('2b. "Title by Creator Name.stl" — multi-word creator', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['Dragon by Bob The Builder.stl']));

    expect(result.title?.value).toBe('Dragon');
    expect(result.creator?.value).toBe('Bob The Builder');
  });

  it('3. "Title v2.stl" → title 0.5, no creator', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['Castle Wall v2.stl']));

    expect(result.title).toEqual({ value: 'Castle Wall', confidence: 0.5 });
    expect(result.creator).toBeUndefined();
  });

  it('8. Version pattern with decimal "v2.3" → title extracted', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['Dragon Head v2.3.stl']));

    expect(result.title?.value).toBe('Dragon Head');
    expect(result.title?.confidence).toBe(0.5);
  });

  it('4. Fallback: plain basename → title 0.3', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['dragon_head_final.stl']));

    expect(result.title).toEqual({ value: 'dragon_head_final', confidence: 0.3 });
    expect(result.creator).toBeUndefined();
  });

  it('5. Multiple files — non-stub file selected as primary', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(
      makeInput(['readme.md', 'license.txt', 'Alice - Dragon.stl']),
    );

    // readme.md and license.txt are stubs — should use dragon.stl
    expect(result.title?.value).toBe('Dragon');
    expect(result.creator?.value).toBe('Alice');
  });

  it('6. All stub files — falls back to first file basename', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['readme.md', 'license.txt']));

    // Falls back to first file: readme (stub)
    expect(result.title).toBeDefined();
    expect(result.title?.confidence).toBe(0.3);
  });

  it('7. Empty files array → empty result', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify({ files: [] });
    expect(result).toEqual({});
  });

  it('9. "Creator - Title" with creator having multiple words', async () => {
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['John Doe - My Fancy Widget.stl']));

    expect(result.creator?.value).toBe('John Doe');
    expect(result.title?.value).toBe('My Fancy Widget');
  });

  it('10. "-" in title not confused for separator (separator has spaces)', async () => {
    // "Title-With-Dashes.stl" — no space around dash → no pattern match → fallback
    const provider = createFilenameProvider();
    const result = await provider.classify(makeInput(['Title-With-Dashes.stl']));

    expect(result.title?.value).toBe('Title-With-Dashes');
    expect(result.title?.confidence).toBe(0.3);
    expect(result.creator).toBeUndefined();
  });
});
