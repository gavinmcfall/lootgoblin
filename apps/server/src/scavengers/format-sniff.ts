/**
 * format-sniff.ts — Magic-byte format detection for staged ingest files.
 *
 * Reads the first 12 bytes of a file and matches against a table of known
 * magic-byte signatures. Falls back to the file extension for formats that
 * are not reliably distinguishable from raw bytes alone (gltf JSON, some
 * STL ASCII variants, OBJ text files).
 *
 * Returns a lowercase, dot-free format string (e.g. 'stl', '3mf', 'png')
 * or null when no match is found.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Default accepted-format allowlist used by the ingest pipeline.
 * Lowercase, no dot. Add new formats here and add a magic-byte entry below.
 */
export const DEFAULT_ACCEPTED_FORMATS: readonly string[] = [
  '3mf',
  'stl',
  'step',
  'stp',
  'obj',
  'gltf',
  'glb',
  'ply',
  '3ds',
  'fbx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'pdf',
  'zip',
];

/**
 * Detect the file format via magic bytes. Reads the first 12 bytes.
 *
 * Strategy:
 *   1. Open the file and read the leading bytes.
 *   2. Check magic-byte signatures (most specific first).
 *   3. If ambiguous or unrecognized, fall back to the file extension.
 *   4. Return null if neither check resolves.
 *
 * @param filePath Absolute path to the file to sniff.
 * @returns Lowercase, dot-free format string or null.
 */
export async function sniffFormat(filePath: string): Promise<string | null> {
  const SNIFF_BYTES = 12;
  let buf: Buffer;

  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(filePath, 'r');
    const { buffer: readBuf } = await fh.read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0);
    buf = readBuf;
  } catch {
    // Unreadable file — fall back to extension only.
    buf = Buffer.alloc(0);
  } finally {
    await fh?.close();
  }

  // ── 1. Unambiguous magic-byte matches ─────────────────────────────────────

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bufStartsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';

  // PDF: 25 50 44 46 2D ("%PDF-")
  if (bufStartsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';

  // GLB (binary glTF): 67 6C 54 46 ("glTF")
  if (bufStartsWith(buf, [0x67, 0x6c, 0x54, 0x46])) return 'glb';

  // PLY: "ply\n" or "ply\r\n"
  if (
    bufStartsWith(buf, [0x70, 0x6c, 0x79, 0x0a]) ||
    bufStartsWith(buf, [0x70, 0x6c, 0x79, 0x0d])
  ) {
    return 'ply';
  }

  // JPEG: FF D8 FF
  if (bufStartsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';

  // WEBP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50 ("RIFF....WEBP")
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp';
  }

  // PK ZIP header (50 4B 03 04): could be 3MF or generic ZIP.
  // Distinguish via file extension — 3MF is a ZIP with a specific structure.
  //
  // NOTE: `model.3mf.zip` would resolve as `'zip'` not `'3mf'` (path.extname
  // returns only the final extension). This is the correct outcome — such a
  // file is not a valid 3MF package — but operators may be confused if they
  // double-extension on purpose. A stricter check would unzip and look for
  // `[Content_Types].xml`; v2 does not do this.
  if (bufStartsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return ext === '3mf' ? '3mf' : 'zip';
  }

  // ── 2. ASCII / text-based formats (read first bytes as text) ──────────────

  if (buf.length > 0) {
    const head = buf.toString('utf8');

    // STL ASCII: starts with "solid "
    if (head.startsWith('solid ')) return 'stl';

    // STEP / STP: starts with "ISO-10303-21;"
    if (head.startsWith('ISO-10303-21;')) return 'step';

    // OBJ: starts with typical OBJ tokens
    if (
      head.startsWith('# ') ||
      head.startsWith('#\n') ||
      head.startsWith('#\r') ||
      head.startsWith('v ') ||
      head.startsWith('vn ') ||
      head.startsWith('g ') ||
      head.startsWith('mtllib ')
    ) {
      return 'obj';
    }

    // GLTF (JSON): starts with "{" — only return if extension confirms it
    if (head.trimStart().startsWith('{')) {
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (ext === 'gltf') return 'gltf';
      // Generic JSON — don't claim a 3D format
    }
  }

  // ── 3. Extension fallback for formats that aren't magic-sniffable ─────────
  //
  // STL binary doesn't have a reliable magic marker (80-byte header is free text).
  // FBX, 3DS, GLTF (JSON variant) fall back here.

  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext.length > 0 && DEFAULT_ACCEPTED_FORMATS.includes(ext)) {
    // Normalize: stp → step for consistency with our format list
    if (ext === 'stp') return 'step';
    if (ext === 'jpg') return 'jpeg';
    return ext;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function bufStartsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}
