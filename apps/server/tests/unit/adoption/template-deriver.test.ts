/**
 * Unit tests for adoption/template-deriver.ts
 *
 * Pure depth-histogram heuristic — no filesystem or DB access.
 *
 * Cases:
 *   1.  Two-level folder pattern → {creator|slug}/{title|slug}
 *   2.  One-level folder pattern → {title|slug}
 *   3.  Mixed depths, no majority → noPatternDetected
 *   4.  All same single-level candidates → {title|slug}
 *   5.  Empty input → no pattern
 *   6.  All top-level files (depth 0) → no pattern
 *   7.  Three-level depth majority → falls back to {creator|slug}/{title|slug}
 *   8.  Exactly 50% majority → no pattern (strict majority required)
 */

import { describe, it, expect } from 'vitest';
import { deriveTemplates } from '../../../src/stash/adoption/template-deriver';
import type { AdoptionCandidate } from '../../../src/stash/adoption';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeCandidate(folderRelativePath: string): AdoptionCandidate {
  return {
    id: crypto.randomUUID(),
    folderRelativePath,
    files: [],
    classification: { needsUserInput: [] },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveTemplates', () => {
  it('detects two-level pattern and proposes {creator|slug}/{title|slug}', () => {
    const candidates = [
      makeCandidate('Alice/Dragon'),
      makeCandidate('Alice/Basilisk'),
      makeCandidate('Bob/Hydra'),
      makeCandidate('Bob/Phoenix'),
    ];
    const result = deriveTemplates(candidates);
    expect(result.patternDetected).toBe(true);
    expect(result.templates).toContain('{creator|slug}/{title|slug}');
  });

  it('detects single-level pattern and proposes {title|slug}', () => {
    const candidates = [
      makeCandidate('Dragon'),
      makeCandidate('Basilisk'),
      makeCandidate('Hydra'),
    ];
    const result = deriveTemplates(candidates);
    expect(result.patternDetected).toBe(true);
    expect(result.templates).toContain('{title|slug}');
  });

  it('returns no pattern when depths vary wildly (no majority)', () => {
    const candidates = [
      makeCandidate('Dragon'), // depth 1
      makeCandidate('Alice/Basilisk'), // depth 2
      makeCandidate('A/B/Hydra'), // depth 3
    ];
    // Each depth appears once — 33% each, no majority
    const result = deriveTemplates(candidates);
    expect(result.patternDetected).toBe(false);
    expect(result.templates).toHaveLength(0);
  });

  it('returns {title|slug} when all candidates are at depth 1', () => {
    const candidates = [
      makeCandidate('DragonA'),
      makeCandidate('DragonB'),
      makeCandidate('DragonC'),
    ];
    const result = deriveTemplates(candidates);
    expect(result.patternDetected).toBe(true);
    expect(result.templates[0]).toBe('{title|slug}');
  });

  it('returns empty + no pattern for empty input', () => {
    const result = deriveTemplates([]);
    expect(result.patternDetected).toBe(false);
    expect(result.templates).toHaveLength(0);
  });

  it('ignores top-level files (depth 0) for pattern detection', () => {
    // Mix of top-level "files" (depth 0) and real folders (depth 1)
    const candidates = [
      makeCandidate(''), // top-level file — depth 0, ignored
      makeCandidate('Dragon'),
      makeCandidate('Basilisk'),
    ];
    // Depth 1 has 2 out of 2 non-zero = 100% → detects pattern
    const result = deriveTemplates(candidates);
    expect(result.patternDetected).toBe(true);
    expect(result.templates).toContain('{title|slug}');
  });

  it('treats all top-level files (depth 0 only) as no pattern', () => {
    const candidates = [
      makeCandidate(''), // depth 0
      makeCandidate(''), // depth 0
    ];
    const result = deriveTemplates(candidates);
    expect(result.patternDetected).toBe(false);
    expect(result.templates).toHaveLength(0);
  });

  it('three-level depth majority maps to {creator|slug}/{title|slug}', () => {
    const candidates = [
      makeCandidate('A/B/C'),
      makeCandidate('A/B/D'),
      makeCandidate('A/B/E'),
    ];
    const result = deriveTemplates(candidates);
    expect(result.patternDetected).toBe(true);
    expect(result.templates).toContain('{creator|slug}/{title|slug}');
  });

  it('exactly 50% majority does not trigger pattern detection', () => {
    // 2 at depth 1, 2 at depth 2 — neither is a strict majority (>50%)
    const candidates = [
      makeCandidate('A'),
      makeCandidate('B'),
      makeCandidate('X/Y'),
      makeCandidate('X/Z'),
    ];
    const result = deriveTemplates(candidates);
    expect(result.patternDetected).toBe(false);
  });
});
