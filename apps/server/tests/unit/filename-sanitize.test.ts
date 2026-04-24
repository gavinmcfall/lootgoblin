/**
 * Unit tests for the shared filename sanitizer used by upload route + URL-driven
 * adapters (cults3d, makerworld, printables, …).
 *
 * Coverage focuses on the corners that bit us in V2-003:
 *   - URL-decoded path traversal (T4 code-review fix 3 / T4-L5)
 *   - UTF-8-aware byte truncation (T5 code-review fix 1 / pillar-level pattern)
 *   - Null bytes / control chars
 *   - Leading dots
 *   - Empty / null / control-only inputs
 */

import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { sanitizeFilename } from '../../src/scavengers/filename-sanitize';

describe('sanitizeFilename', () => {
  describe('path-traversal handling', () => {
    it('strips literal path separators', () => {
      expect(sanitizeFilename('../etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('..\\windows\\system32\\foo.dll')).toBe('foo.dll');
    });

    it('URL-decodes percent-encoded separators before splitting', () => {
      expect(sanitizeFilename('..%2F..%2Fpasswd')).toBe('passwd');
      expect(sanitizeFilename('..%5Cpasswd')).toBe('passwd');
      expect(sanitizeFilename('..%2f..%2Fpasswd')).toBe('passwd'); // mixed case hex
    });

    it('handles malformed percent-encoding by falling back to raw input', () => {
      // '%2' is incomplete; decodeURIComponent throws URIError. The sanitizer
      // must catch and continue with the literal string.
      const result = sanitizeFilename('file%2.txt');
      expect(result).not.toBeNull();
      // Either 'file%2.txt' (raw fallback) or some literal form — but NOT a throw.
      expect(typeof result).toBe('string');
    });
  });

  describe('UTF-8-aware byte cap (T5 code-review Fix 1)', () => {
    it('produces output ≤ 255 bytes when input has emoji at the cap boundary', () => {
      // 253 ASCII bytes + 4-byte emoji = 257 bytes. Naive Buffer.slice(0,255).toString('utf8')
      // would land mid-emoji at byte 253 → Node inserts U+FFFD (3 bytes) → 256-byte output.
      const filename = 'a'.repeat(253) + '\u{1F600}.stl';
      const result = sanitizeFilename(filename);
      expect(result).not.toBeNull();
      const byteLength = Buffer.byteLength(result!, 'utf8');
      expect(byteLength).toBeLessThanOrEqual(255);
    });

    it('does not insert U+FFFD replacement chars on truncation', () => {
      const filename = 'a'.repeat(253) + '\u{1F600}.stl';
      const result = sanitizeFilename(filename);
      expect(result).not.toBeNull();
      expect(result!).not.toContain('�');
    });

    it('preserves complete multibyte codepoints near the cap boundary', () => {
      // 252 ASCII + 3-byte char (e.g. CJK 中) = 255 bytes exactly. Should preserve everything.
      const filename = 'a'.repeat(252) + '中';
      const result = sanitizeFilename(filename);
      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!, 'utf8')).toBe(255);
      expect(result).toContain('中');
    });

    it('passes short ASCII filenames through unchanged', () => {
      expect(sanitizeFilename('model.stl')).toBe('model.stl');
      expect(sanitizeFilename('Dragon - Final v3.3mf')).toBe('Dragon - Final v3.3mf');
    });
  });

  describe('null bytes + control chars', () => {
    it('strips null bytes', () => {
      expect(sanitizeFilename('foo\x00bar.txt')).toBe('foobar.txt');
    });

    it('strips C0 control chars (0x01–0x1F)', () => {
      expect(sanitizeFilename('foo\x01\x07\x1Fbar.txt')).toBe('foobar.txt');
    });
  });

  describe('leading dots + empty edge cases', () => {
    it('strips leading dots (hidden-file → visible)', () => {
      expect(sanitizeFilename('..env')).toBe('env');
      expect(sanitizeFilename('....')).toBeNull(); // all-dots collapses to empty
      expect(sanitizeFilename('.hidden')).toBe('hidden');
    });

    it('returns null for empty input', () => {
      expect(sanitizeFilename('')).toBeNull();
    });

    it('returns null for control-only input', () => {
      expect(sanitizeFilename('\x00\x01\x02')).toBeNull();
    });
  });
});
