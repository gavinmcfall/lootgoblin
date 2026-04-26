/**
 * Unit tests for the datapackage.json classifier provider — V2-002-T6
 *
 * Seeds datapackage.json files in a tmp directory and tests parsing.
 *
 * Test scenarios:
 *   1. Full datapackage.json → all fields extracted.
 *   2. Partial (title + keywords only).
 *   3. Malformed JSON → empty result, no throw.
 *   4. Missing datapackage.json → empty result.
 *   5. datapackage.json with empty creators array → creator not emitted.
 *   6. keywords array with non-string values → graceful filter.
 *   7. Empty string values → fields not emitted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDatapackageProvider } from '../../../src/stash/classifier-providers/datapackage';
import type { ClassifierInput } from '../../../src/stash/classifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function writeDp(filename: string, content: unknown): Promise<string> {
  const filePath = path.join(tmpDir, filename);
  await fs.writeFile(filePath, JSON.stringify(content), 'utf-8');
  return filePath;
}

async function writeRaw(filename: string, content: string): Promise<string> {
  const filePath = path.join(tmpDir, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

function makeInput(absolutePath: string): ClassifierInput {
  return {
    files: [
      {
        absolutePath,
        relativePath: path.basename(absolutePath),
        size: 0,
        mtime: new Date(),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-dp-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDatapackageProvider', () => {
  it('1. full datapackage.json → all fields at correct confidences', async () => {
    const filePath = await writeDp('datapackage.json', {
      name: 'castle-wall',
      title: 'Castle Wall',
      description: 'A decorative castle wall piece',
      licenses: [{ name: 'CC-BY-4.0' }],
      creators: [{ title: 'Alice' }],
      keywords: ['fantasy', 'dnd', 'terrain'],
    });

    const provider = createDatapackageProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.title).toEqual({ value: 'Castle Wall', confidence: 0.95 });
    expect(result.creator).toEqual({ value: 'Alice', confidence: 0.9 });
    expect(result.description).toEqual({
      value: 'A decorative castle wall piece',
      confidence: 0.85,
    });
    expect(result.license).toEqual({ value: 'CC-BY-4.0', confidence: 0.9 });
    expect(result.tags).toEqual({
      value: ['fantasy', 'dnd', 'terrain'],
      confidence: 0.85,
    });
  });

  it('2. partial (title + keywords only) → only those fields emitted', async () => {
    const filePath = await writeDp('datapackage.json', {
      title: 'Dragon Head',
      keywords: ['dragon', 'fantasy'],
    });

    const provider = createDatapackageProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.title).toEqual({ value: 'Dragon Head', confidence: 0.95 });
    expect(result.tags?.value).toEqual(['dragon', 'fantasy']);
    expect(result.creator).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.license).toBeUndefined();
  });

  it('3. malformed JSON → empty result, no throw', async () => {
    const filePath = await writeRaw('datapackage.json', '{ invalid json !!!');

    const provider = createDatapackageProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result).toEqual({});
  });

  it('4. no datapackage.json in input → empty result', async () => {
    const input: ClassifierInput = {
      files: [
        {
          absolutePath: path.join(tmpDir, 'model.stl'),
          relativePath: 'model.stl',
          size: 1000,
          mtime: new Date(),
        },
      ],
    };

    const provider = createDatapackageProvider();
    const result = await provider.classify(input);

    expect(result).toEqual({});
  });

  it('5. empty creators array → creator not emitted', async () => {
    const filePath = await writeDp('datapackage.json', {
      title: 'My Model',
      creators: [],
    });

    const provider = createDatapackageProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.title?.value).toBe('My Model');
    expect(result.creator).toBeUndefined();
  });

  it('6. keywords with non-string values → only strings kept', async () => {
    const filePath = await writeDp('datapackage.json', {
      title: 'Test',
      keywords: ['valid', 42, null, 'also-valid'],
    });

    const provider = createDatapackageProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.tags?.value).toEqual(['valid', 'also-valid']);
  });

  it('7. empty string title → title not emitted', async () => {
    const filePath = await writeDp('datapackage.json', {
      title: '   ',
      creators: [{ title: '  ' }],
      description: '',
    });

    const provider = createDatapackageProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.title).toBeUndefined();
    expect(result.creator).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it('8. empty input files → empty result', async () => {
    const provider = createDatapackageProvider();
    const result = await provider.classify({ files: [] });
    expect(result).toEqual({});
  });

  it('9. oversize datapackage.json (>1 MB) → empty result, file not parsed', async () => {
    // Build a datapackage.json larger than the 1,000,000-byte limit.
    // Keep the file syntactically valid so we can prove the size guard
    // short-circuits BEFORE JSON.parse would have succeeded.
    const padding = 'x'.repeat(1_100_000);
    const filePath = await writeDp('datapackage.json', {
      title: 'Should Not Be Emitted',
      description: padding,
    });

    // Sanity check: the file really is oversized.
    const { size } = await fs.stat(filePath);
    expect(size).toBeGreaterThan(1_000_000);

    const provider = createDatapackageProvider();
    const result = await provider.classify(makeInput(filePath));

    // Size guard skips the file — nothing extracted.
    expect(result).toEqual({});
  });
});
