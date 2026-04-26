/**
 * Unit tests for format-sniff.ts
 *
 * Each test writes fixture bytes to /tmp and checks that sniffFormat returns
 * the expected format string (or null). Covers all major magic-byte branches
 * and the extension-fallback path.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { sniffFormat } from '../../src/scavengers/format-sniff';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpFiles: string[] = [];

async function writeTmp(name: string, content: Buffer | string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-sniff-'));
  const p = path.join(dir, name);
  await fsp.writeFile(p, content);
  tmpFiles.push(dir);
  return p;
}

afterEach(async () => {
  for (const d of tmpFiles.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sniffFormat — magic bytes', () => {
  it('PNG: returns "png"', async () => {
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const p = await writeTmp('image.png', magic);
    expect(await sniffFormat(p)).toBe('png');
  });

  it('JPEG: returns "jpeg"', async () => {
    const magic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const p = await writeTmp('photo.jpg', magic);
    expect(await sniffFormat(p)).toBe('jpeg');
  });

  it('PDF: returns "pdf"', async () => {
    const magic = Buffer.from('%PDF-1.7\n', 'ascii');
    const p = await writeTmp('document.pdf', magic);
    expect(await sniffFormat(p)).toBe('pdf');
  });

  it('GLB (binary glTF): returns "glb"', async () => {
    // magic: 67 6C 54 46 (glTF)
    const magic = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
    const p = await writeTmp('model.glb', magic);
    expect(await sniffFormat(p)).toBe('glb');
  });

  it('PLY: returns "ply"', async () => {
    const magic = Buffer.from('ply\nformat ascii 1.0\n', 'ascii');
    const p = await writeTmp('mesh.ply', magic);
    expect(await sniffFormat(p)).toBe('ply');
  });

  it('WEBP: returns "webp"', async () => {
    const magic = Buffer.alloc(12);
    magic.write('RIFF', 0, 'ascii');
    magic.writeUInt32LE(1234, 4);
    magic.write('WEBP', 8, 'ascii');
    const p = await writeTmp('image.webp', magic);
    expect(await sniffFormat(p)).toBe('webp');
  });

  it('ZIP (PK header, non-.3mf extension): returns "zip"', async () => {
    const magic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const p = await writeTmp('archive.zip', magic);
    expect(await sniffFormat(p)).toBe('zip');
  });

  it('3MF (PK header, .3mf extension): returns "3mf"', async () => {
    const magic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const p = await writeTmp('model.3mf', magic);
    expect(await sniffFormat(p)).toBe('3mf');
  });
});

describe('sniffFormat — ASCII / text-based', () => {
  it('STL ASCII (starts with "solid "): returns "stl"', async () => {
    const content = Buffer.from('solid model\nfacet normal 0 0 1\n', 'ascii');
    const p = await writeTmp('model.stl', content);
    expect(await sniffFormat(p)).toBe('stl');
  });

  it('STL binary (no magic, extension fallback): returns "stl"', async () => {
    // STL binary starts with 80-byte header (free text) — no reliable magic.
    const header = Buffer.alloc(84, 0x00);
    const p = await writeTmp('model.stl', header);
    expect(await sniffFormat(p)).toBe('stl');
  });

  it('STEP (starts with "ISO-10303-21;"): returns "step"', async () => {
    const content = Buffer.from('ISO-10303-21;\nHEADER;\n', 'ascii');
    const p = await writeTmp('part.step', content);
    expect(await sniffFormat(p)).toBe('step');
  });

  it('STP extension fallback: returns "step"', async () => {
    const content = Buffer.from('ISO-10303-21;\n', 'ascii');
    const p = await writeTmp('part.stp', content);
    // Magic matches STEP directly
    expect(await sniffFormat(p)).toBe('step');
  });

  it('GLTF JSON (extension-confirmed): returns "gltf"', async () => {
    const content = Buffer.from('{"asset":{"version":"2.0"}}', 'utf8');
    const p = await writeTmp('scene.gltf', content);
    expect(await sniffFormat(p)).toBe('gltf');
  });

  it('Generic JSON (non-.gltf extension): returns null (or extension fallback)', async () => {
    const content = Buffer.from('{"foo":"bar"}', 'utf8');
    const p = await writeTmp('data.json', content);
    // .json is not in DEFAULT_ACCEPTED_FORMATS, so should return null
    expect(await sniffFormat(p)).toBeNull();
  });
});

describe('sniffFormat — extension fallback', () => {
  it('OBJ file with OBJ-token prefix: returns "obj"', async () => {
    const content = Buffer.from('# OBJ file\nv 0 0 0\n', 'ascii');
    const p = await writeTmp('mesh.obj', content);
    expect(await sniffFormat(p)).toBe('obj');
  });

  it('Unknown extension: returns null', async () => {
    const content = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]);
    const p = await writeTmp('file.exe', content);
    expect(await sniffFormat(p)).toBeNull();
  });
});
