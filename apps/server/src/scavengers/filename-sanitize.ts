/**
 * filename-sanitize.ts — shared filename sanitizer for ScavengerAdapters.
 *
 * Extracted from the upload route (V2-003-T4) so that URL-driven adapters
 * (cults3d, makerworld, printables, etc.) can apply the same rules to
 * source-supplied filenames without duplicating the logic.
 *
 * Rules:
 *   1. URL-decode the input first — catches percent-encoded traversal
 *      (e.g. `..%2F..%2Fpasswd`) before the path-separator split.
 *   2. Strip everything up to and including the last path separator (/ or \)
 *      to prevent directory traversal.
 *   3. Remove null bytes (\0) and ASCII control characters (0x01–0x1F).
 *   4. Strip leading dots (prevents hidden-file creation: .env, ..evil).
 *   5. Truncate to 255 bytes (filesystem limit on most platforms).
 *
 * Returns null when the result is empty after sanitization — callers should
 * substitute a safe fallback name.
 *
 * @see T4-L4: Leading-dot strip only — trailing dots on names with other
 *   content are acceptable (e.g. 'archive...' → preserved).
 * @see T4-L5: URL-decode BEFORE split — encoded traversal is a latent hazard
 *   for any downstream consumer that decodes the filename.
 */
export function sanitizeFilename(raw: string): string | null {
  if (!raw) return null;

  // Decode percent-encoded separators BEFORE splitting.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding (e.g. `file%2.txt`) — fall back to raw input.
    // The remaining strip rules still apply.
    decoded = raw;
  }

  // Strip path traversal: take only the basename component.
  const base = decoded.split(/[/\\]/).pop();
  if (!base) return null;

  // Remove null bytes and ASCII control characters (U+0000–U+001F).
  const noControl = base.replace(/[\x00-\x1F]/g, '');

  // Strip leading dots (prevents hidden files like .env, ..evil).
  const cleaned = noControl.replace(/^\.+/, '');

  if (cleaned.length === 0) return null;

  // Truncate to 255 bytes (UTF-8 aware).
  // Buffer.slice drops incomplete multibyte sequences silently — intentional.
  const truncated = Buffer.from(cleaned).slice(0, 255).toString('utf8');

  return truncated.length > 0 ? truncated : null;
}
