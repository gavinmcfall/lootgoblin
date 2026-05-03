/**
 * V2-005e-T_e3: Dice's bigram coefficient — pure unit tests.
 */

import { describe, it, expect } from 'vitest';

import { diceCoefficient } from '../../src/forge/slice-pairings/string-similarity';

describe('diceCoefficient', () => {
  it('returns 1.0 for identical strings', () => {
    expect(diceCoefficient('cube', 'cube')).toBe(1.0);
  });

  it('returns 0.0 for strings with no shared bigrams', () => {
    expect(diceCoefficient('ab', 'cd')).toBe(0.0);
  });

  it('returns 0.0 when either string is shorter than 2 chars', () => {
    expect(diceCoefficient('a', 'abc')).toBe(0.0);
    expect(diceCoefficient('abc', '')).toBe(0.0);
  });

  it('returns a value in (0, 1) for partial overlap', () => {
    const score = diceCoefficient('night', 'nacht');
    // 'ni','ig','gh','ht' vs 'na','ac','ch','ht' → 1 shared bigram ('ht')
    // Dice = 2 * 1 / (4 + 4) = 0.25
    expect(score).toBeCloseTo(0.25, 2);
  });

  it('is symmetric', () => {
    expect(diceCoefficient('foobar', 'barfoo')).toBeCloseTo(
      diceCoefficient('barfoo', 'foobar'),
      6,
    );
  });
});
