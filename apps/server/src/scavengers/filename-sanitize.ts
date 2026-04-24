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

  // Filesystems typically cap filenames at 255 bytes. Truncate with UTF-8-
  // awareness: Buffer.slice + toString('utf8') inserts U+FFFD for incomplete
  // multibyte sequences, which can push the re-encoded string beyond 255
  // bytes. Step back over any partial sequence so the result is valid UTF-8
  // AND ≤ 255 bytes.
  const truncated = truncateToBytes(cleaned, 255);

  return truncated.length > 0 ? truncated : null;
}

/**
 * Truncate a string to at most `maxBytes` bytes when encoded as UTF-8,
 * without producing an invalid encoding or replacement chars (U+FFFD).
 *
 * Approach: encode → if already short enough, return; else clip the byte
 * buffer at `maxBytes`, then walk back over any partial codepoint:
 *   - continuation bytes:  0b10xxxxxx  (0x80–0xBF)
 *   - leading byte alone:  0b11xxxxxx  (0xC0–0xFF) without enough following continuations
 *
 * Naive `Buffer.slice(0, maxBytes).toString('utf8')` looks safe but is NOT —
 * Node replaces a partial codepoint with U+FFFD (3 bytes), so a clip that
 * lands mid-emoji at byte 253 produces a 256-byte output. This helper
 * removes the partial bytes BEFORE re-encoding so the byte cap is real.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  const encoded = Buffer.from(s, 'utf8');
  if (encoded.length <= maxBytes) return s;

  let end = maxBytes;

  // Step back over continuation bytes (0b10xxxxxx).
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;

  // If we landed on a leading byte of a multibyte sequence (0b11xxxxxx),
  // step back one more — that codepoint is incomplete because we just
  // dropped its continuation bytes above.
  if (end > 0 && (encoded[end]! & 0xc0) === 0xc0) end--;

  return encoded.slice(0, end).toString('utf8');
}
