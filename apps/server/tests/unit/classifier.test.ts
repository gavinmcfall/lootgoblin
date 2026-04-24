/**
 * Unit tests for the classifier consensus combiner — V2-002-T6
 *
 * Tests the createClassifier() function with stub providers to verify the
 * consensus algorithm independent of real file I/O.
 *
 * Scenarios:
 *   1.  Single provider → its output is the result.
 *   2.  Two providers with different fields → union.
 *   3.  Two providers same field, different confidence → higher wins.
 *   4.  Two providers same field, same confidence → first provider wins.
 *   5.  Required field with no provider output → added to needsUserInput.
 *   6.  Required field below threshold → added to needsUserInput.
 *   7.  tags field UNIONs across providers.
 *   8.  Empty input (no files) → all required fields in needsUserInput.
 *   9.  Custom confidenceThreshold respected.
 *   10. Custom requiredFields respected.
 *   11. Provider returning empty object → gracefully handled.
 *   12. tags below threshold → not emitted.
 *   13. Provider throws → rejects (Promise.all propagates).
 *   14. Tags from multiple providers union + deduplicate.
 *   15. primaryFormat field treated as scalar.
 */

import { describe, it, expect } from 'vitest';
import { createClassifier } from '../../src/stash/classifier';
import type { ClassifierProvider, ClassifierInput, PartialClassification } from '../../src/stash/classifier';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const EMPTY_INPUT: ClassifierInput = {
  files: [],
};

function makeInput(overrides?: Partial<ClassifierInput>): ClassifierInput {
  return { files: [], ...overrides };
}

function stubProvider(name: string, result: PartialClassification): ClassifierProvider {
  return {
    name,
    classify: async (_input) => result,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createClassifier — consensus combiner', () => {
  it('1. single provider output becomes the result', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', {
          title: { value: 'My Model', confidence: 0.9 },
          creator: { value: 'Alice', confidence: 0.8 },
        }),
      ],
    });

    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.title).toEqual({ value: 'My Model', confidence: 0.9, source: 'a' });
    expect(result.creator).toEqual({ value: 'Alice', confidence: 0.8, source: 'a' });
    expect(result.needsUserInput).toEqual([]);
  });

  it('2. two providers with different fields → union of fields', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', { title: { value: 'My Model', confidence: 0.9 } }),
        stubProvider('b', { creator: { value: 'Bob', confidence: 0.85 } }),
      ],
    });

    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.title?.value).toBe('My Model');
    expect(result.title?.source).toBe('a');
    expect(result.creator?.value).toBe('Bob');
    expect(result.creator?.source).toBe('b');
    expect(result.needsUserInput).toEqual([]);
  });

  it('3. two providers same field, higher confidence wins', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('low', { title: { value: 'Weak Title', confidence: 0.5 } }),
        stubProvider('high', { title: { value: 'Strong Title', confidence: 0.9 } }),
      ],
    });

    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.title?.value).toBe('Strong Title');
    expect(result.title?.confidence).toBe(0.9);
    expect(result.title?.source).toBe('high');
  });

  it('4. two providers same field, same confidence → first provider wins', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('first', { title: { value: 'First Title', confidence: 0.7 } }),
        stubProvider('second', { title: { value: 'Second Title', confidence: 0.7 } }),
      ],
    });

    const result = await classifier.classify(EMPTY_INPUT);

    // First provider registers confidence 0.7; second also has 0.7 but
    // strict greater-than means first is NOT replaced.
    expect(result.title?.value).toBe('First Title');
    expect(result.title?.source).toBe('first');
  });

  it('5. required field with no provider output → added to needsUserInput', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', { creator: { value: 'Alice', confidence: 0.9 } }),
      ],
      // title is required by default
    });

    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.title).toBeUndefined();
    expect(result.needsUserInput).toContain('title');
  });

  it('6. required field below threshold → added to needsUserInput, not emitted', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', { title: { value: 'Weak Title', confidence: 0.2 } }),
      ],
      confidenceThreshold: 0.4,
      // title is required by default
    });

    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.title).toBeUndefined();
    expect(result.needsUserInput).toContain('title');
  });

  it('7. tags field UNIONs across providers', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', { tags: { value: ['print', 'stl'], confidence: 0.8 } }),
        stubProvider('b', { tags: { value: ['stl', 'makernexus'], confidence: 0.7 } }),
      ],
    });

    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.tags).toBeDefined();
    expect(result.tags!.value).toEqual(expect.arrayContaining(['print', 'stl', 'makernexus']));
    expect(result.tags!.value).toHaveLength(3); // deduped
    // confidence = max of contributing providers
    expect(result.tags!.confidence).toBe(0.8);
    expect(result.tags!.source).toBe('a');
  });

  it('8. empty input (no files, zero providers) → required fields in needsUserInput', async () => {
    const classifier = createClassifier({ providers: [] });
    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.title).toBeUndefined();
    expect(result.needsUserInput).toContain('title');
    expect(result.creator).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it('9. custom confidenceThreshold respected — field above threshold is emitted', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', { creator: { value: 'Alice', confidence: 0.6 } }),
      ],
      confidenceThreshold: 0.5,
    });

    const result = await classifier.classify(EMPTY_INPUT);
    expect(result.creator?.value).toBe('Alice');
  });

  it('9b. custom confidenceThreshold — field at threshold is emitted (>= comparison)', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', { creator: { value: 'Alice', confidence: 0.5 } }),
      ],
      confidenceThreshold: 0.5,
    });

    const result = await classifier.classify(EMPTY_INPUT);
    expect(result.creator?.value).toBe('Alice');
  });

  it('10. custom requiredFields — missing custom required field goes to needsUserInput', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', { title: { value: 'My Model', confidence: 0.9 } }),
      ],
      requiredFields: ['title', 'creator'],
    });

    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.title?.value).toBe('My Model');
    expect(result.needsUserInput).toContain('creator');
    expect(result.needsUserInput).not.toContain('title');
  });

  it('11. provider returning empty object → gracefully handled with no output', async () => {
    const classifier = createClassifier({
      providers: [stubProvider('empty', {})],
    });

    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.title).toBeUndefined();
    expect(result.creator).toBeUndefined();
    expect(result.needsUserInput).toContain('title');
  });

  it('12. tags below threshold → not emitted', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', { tags: { value: ['tag1'], confidence: 0.1 } }),
      ],
      confidenceThreshold: 0.4,
    });

    const result = await classifier.classify(EMPTY_INPUT);
    expect(result.tags).toBeUndefined();
  });

  it('13. provider that rejects → classifier rejects', async () => {
    const badProvider: ClassifierProvider = {
      name: 'bad',
      classify: async () => { throw new Error('provider failed'); },
    };

    const classifier = createClassifier({ providers: [badProvider] });
    await expect(classifier.classify(EMPTY_INPUT)).rejects.toThrow('provider failed');
  });

  it('14. tags from multiple providers deduplicate correctly', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('a', { tags: { value: ['a', 'b', 'c'], confidence: 0.9 } }),
        stubProvider('b', { tags: { value: ['b', 'c', 'd'], confidence: 0.85 } }),
        stubProvider('c', { tags: { value: ['d', 'e'], confidence: 0.6 } }),
      ],
    });

    const result = await classifier.classify(EMPTY_INPUT);

    expect(result.tags!.value.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.tags!.confidence).toBe(0.9);
  });

  it('15. primaryFormat treated as scalar field — highest confidence wins', async () => {
    const classifier = createClassifier({
      providers: [
        stubProvider('file-watcher', { primaryFormat: { value: 'stl', confidence: 0.5 } }),
        stubProvider('three-mf', { primaryFormat: { value: '3mf', confidence: 0.95 } }),
      ],
    });

    const result = await classifier.classify(EMPTY_INPUT);
    expect(result.primaryFormat?.value).toBe('3mf');
    expect(result.primaryFormat?.confidence).toBe(0.95);
  });

  it('16. providers run concurrently — all provider outputs combined', async () => {
    // Verify Promise.all behaviour: both providers execute even if one is slow.
    let providerBCalled = false;
    const providerA = stubProvider('a', { title: { value: 'Title A', confidence: 0.9 } });
    const providerB: ClassifierProvider = {
      name: 'b',
      classify: async () => {
        providerBCalled = true;
        return { creator: { value: 'Creator B', confidence: 0.9 } };
      },
    };

    const classifier = createClassifier({ providers: [providerA, providerB] });
    const result = await classifier.classify(EMPTY_INPUT);

    expect(providerBCalled).toBe(true);
    expect(result.title?.value).toBe('Title A');
    expect(result.creator?.value).toBe('Creator B');
  });

  it('17. needsUserInput does not contain duplicate entries', async () => {
    const classifier = createClassifier({
      providers: [],
      requiredFields: ['title', 'title'], // de-dup guard
    });

    const result = await classifier.classify(EMPTY_INPUT);
    const titleCount = result.needsUserInput.filter((f) => f === 'title').length;
    expect(titleCount).toBe(1);
  });
});
