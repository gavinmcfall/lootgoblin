/**
 * V2-005e-T_e3: Bigram Dice's coefficient — pure utility.
 *
 * Returns a similarity score in [0.0, 1.0] for two strings:
 *   1.0 = identical
 *   0.0 = no shared bigrams
 *
 * Used by the filename heuristic in source-Loot association: the slicer-
 * stripped slice basename is compared against owner Loot titles, and a
 * confidence >= HEURISTIC_THRESHOLD (0.7) produces a candidate match.
 *
 * Why Dice's over Levenshtein?
 *   - Dice's is order-tolerant on bigrams, which fits filename-vs-title
 *     fuzzy matching (e.g. "cube_v2" vs "Cube V2") better than edit
 *     distance.
 *   - O(n+m) bigram count comparison is cheap enough to run against every
 *     owner Loot row at slice-arrival time without indexing.
 */

export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0.0;

  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);

  let intersection = 0;
  for (const [k, v] of aBigrams) {
    const bCount = bBigrams.get(k) ?? 0;
    intersection += Math.min(v, bCount);
  }
  // Each string of length L contributes (L-1) bigrams; union magnitude
  // is the sum.
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bigram = s.slice(i, i + 2);
    out.set(bigram, (out.get(bigram) ?? 0) + 1);
  }
  return out;
}
