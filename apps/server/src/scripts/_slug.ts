/**
 * Slug helper — V2-007b T_B5a.
 *
 * Pure deterministic slugification used by the SpoolmanDB seed-import script
 * (and any other seed-import that needs stable, idempotent ids).
 *
 *   - lowercase ASCII
 *   - replace whitespace + non-alphanumeric with `-`
 *   - collapse runs of `-`
 *   - trim leading/trailing `-`
 *   - if longer than 80 chars: truncate to 72 + 8-char hex hash of the
 *     pre-truncation string, joined by `-`. This keeps slugs stable for the
 *     same input while avoiding pathological lengths in DB ids.
 */

import * as crypto from 'node:crypto';

const MAX_SEGMENT_LEN = 80;
const HASH_LEN = 8;
// Prefix length leaves room for `-` + HASH_LEN, so output stays <= MAX_SEGMENT_LEN.
const TRUNCATE_PREFIX_LEN = MAX_SEGMENT_LEN - HASH_LEN - 1; // 71

export function slugify(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    return 'unknown';
  }
  const lowered = input.toLowerCase();
  // Replace anything non a-z 0-9 with `-`.
  const subbed = lowered.replace(/[^a-z0-9]+/g, '-');
  // Collapse multiple `-` (regex above can produce them around boundaries).
  const collapsed = subbed.replace(/-+/g, '-');
  // Trim.
  const trimmed = collapsed.replace(/^-+/, '').replace(/-+$/, '');
  if (trimmed.length === 0) {
    // All input was special chars — fall back to a hash so we still get a
    // deterministic, unique slug.
    const hash = crypto
      .createHash('sha256')
      .update(input)
      .digest('hex')
      .slice(0, HASH_LEN);
    return `x-${hash}`;
  }
  if (trimmed.length <= MAX_SEGMENT_LEN) {
    return trimmed;
  }
  // Truncate-with-hash: take first 72 chars + 8-char hash of the original
  // trimmed (pre-truncation) string. Same input -> same output.
  const hash = crypto
    .createHash('sha256')
    .update(trimmed)
    .digest('hex')
    .slice(0, HASH_LEN);
  const prefix = trimmed.slice(0, TRUNCATE_PREFIX_LEN).replace(/-+$/, '');
  return `${prefix}-${hash}`;
}
