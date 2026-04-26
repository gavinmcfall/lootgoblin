/**
 * Unit tests for adoption/preview.ts
 *
 * Pure template-option building — no filesystem or DB access.
 *
 * Cases:
 *   1.  Template matches 100% of candidates → predictedLootCount = all
 *   2.  Collision case → two candidates that resolve to the same path
 *   3.  Incompatible case → candidate missing required field
 *   4.  Empty candidates → predictedLootCount = 0
 *   5.  Multiple templates → sorted by predictedLootCount desc
 *   6.  Up to 5 examples collected even with more candidates
 */

import { describe, it, expect } from 'vitest';
import { buildTemplateOptions } from '../../../src/stash/adoption/preview';
import type { AdoptionCandidate } from '../../../src/stash/adoption';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  id: string,
  folderRelativePath: string,
  classification: Partial<AdoptionCandidate['classification']> = {},
): AdoptionCandidate {
  return {
    id,
    folderRelativePath,
    files: [],
    classification: {
      needsUserInput: [],
      ...classification,
    },
  };
}

function classified(title: string, creator?: string): Partial<AdoptionCandidate['classification']> {
  return {
    title: { value: title, confidence: 0.9, source: 'test' },
    ...(creator ? { creator: { value: creator, confidence: 0.9, source: 'test' } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildTemplateOptions', () => {
  it('returns 100% predictedLootCount when template matches all candidates', () => {
    const candidates = [
      makeCandidate('c1', 'Alice/Dragon', classified('Dragon', 'Alice')),
      makeCandidate('c2', 'Alice/Basilisk', classified('Basilisk', 'Alice')),
      makeCandidate('c3', 'Bob/Hydra', classified('Hydra', 'Bob')),
    ];
    const options = buildTemplateOptions(['{creator|slug}/{title|slug}'], candidates);
    expect(options).toHaveLength(1);
    expect(options[0]!.predictedLootCount).toBe(3);
    expect(options[0]!.collisions).toHaveLength(0);
    expect(options[0]!.incompatible).toHaveLength(0);
  });

  it('detects collision when two candidates resolve to the same path', () => {
    const candidates = [
      makeCandidate('c1', 'Alice/Dragon', classified('dragon', 'alice')),
      makeCandidate('c2', 'Alice/Dragon2', classified('dragon', 'alice')), // same slug!
    ];
    const options = buildTemplateOptions(['{creator|slug}/{title|slug}'], candidates);
    expect(options[0]!.collisions).toHaveLength(1);
    expect(options[0]!.collisions[0]!.candidateIds).toContain('c1');
    expect(options[0]!.collisions[0]!.candidateIds).toContain('c2');
    // Neither is predicted (both collide)
    expect(options[0]!.predictedLootCount).toBe(0);
  });

  it('marks candidate as incompatible when required field is missing', () => {
    const candidates = [
      makeCandidate('c1', 'Alice/Dragon', classified('Dragon', 'Alice')),
      makeCandidate('c2', 'Orphan', {
        // No title provided — template requires {creator}
        needsUserInput: ['creator'],
      }),
    ];
    const options = buildTemplateOptions(['{creator|slug}/{title|slug}'], candidates);
    expect(options[0]!.incompatible.some((i) => i.candidateId === 'c2')).toBe(true);
    expect(options[0]!.incompatible[0]!.reason).toBe('missing-field');
  });

  it('returns predictedLootCount = 0 for empty candidates', () => {
    const options = buildTemplateOptions(['{title|slug}'], []);
    expect(options[0]!.predictedLootCount).toBe(0);
    expect(options[0]!.examples).toHaveLength(0);
  });

  it('sorts multiple templates by predictedLootCount desc', () => {
    const candidates = [
      // Has title only → {title|slug} matches, {creator|slug}/{title|slug} fails
      makeCandidate('c1', 'Dragon', classified('Dragon')),
      makeCandidate('c2', 'Basilisk', classified('Basilisk')),
      // Has both → both templates match
      makeCandidate('c3', 'Alice/Hydra', classified('Hydra', 'Alice')),
    ];
    const options = buildTemplateOptions(
      ['{creator|slug}/{title|slug}', '{title|slug}'],
      candidates,
    );
    // {title|slug} should match all 3, {creator|slug}/{title|slug} matches 1 (c3 only)
    expect(options[0]!.template).toBe('{title|slug}');
    expect(options[0]!.predictedLootCount).toBeGreaterThan(options[1]!.predictedLootCount);
  });

  it('collects up to 5 examples even with more candidates', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate(`c${i}`, `item${i}`, classified(`Item ${i}`, 'Alice')),
    );
    const options = buildTemplateOptions(['{creator|slug}/{title|slug}'], candidates);
    expect(options[0]!.examples.length).toBeLessThanOrEqual(5);
  });

  it('provides before→after path examples', () => {
    const candidates = [
      makeCandidate('c1', 'Alice/Dragon', classified('Dragon', 'Alice')),
    ];
    const options = buildTemplateOptions(['{creator|slug}/{title|slug}'], candidates);
    const example = options[0]!.examples[0]!;
    expect(example.candidateId).toBe('c1');
    expect(example.currentPath).toBe('Alice/Dragon');
    expect(example.proposedPath).toBe('alice/dragon');
  });
});
