/**
 * Unit tests — V2-005d-b T_db2
 *
 * AMS metadata extractor for Bambu Studio / OrcaSlicer `.gcode.3mf`.
 *
 * Fixtures are built programmatically with JSZip in beforeAll — no binary
 * files are committed. The slice_info.config schema mirrors what Bambu
 * Studio is documented to emit (T_db5 will validate against a real
 * printer's output and adjust if the assumption was wrong).
 *
 * Covers:
 *   1. Happy path — 4-color AMS print returns useAms=true and slot mapping.
 *   2. Single-color print (no <filament> tags) — safe defaults, useAms=false.
 *   3. Malformed zip — safe defaults, no throw.
 *   4. Missing slice_info.config entry — safe defaults, no throw.
 *   5. File not found — safe defaults, no throw.
 *   6. subtaskName derivation — `.gcode.3mf` and `.3mf` suffix stripping.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';

import { extractAmsConfig } from '../../src/forge/dispatch/bambu/ams-extractor';

let tmpDir: string;

async function writeZipWithSliceInfo(filename: string, xml: string): Promise<string> {
  const zip = new JSZip();
  zip.file('Metadata/slice_info.config', xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const filepath = path.join(tmpDir, filename);
  await fs.writeFile(filepath, buf);
  return filepath;
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ams-extractor-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('extractAmsConfig — happy path 4-color AMS', () => {
  it('returns useAms=true with slot mapping [0,1,2,3]', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="0" type="PLA" color="#FF0000"/>
    <filament id="1" type="PLA" color="#00FF00"/>
    <filament id="2" type="PLA" color="#0000FF"/>
    <filament id="3" type="PLA" color="#FFFFFF"/>
  </plate>
</config>`;
    const fixturePath = await writeZipWithSliceInfo('multi-color.gcode.3mf', xml);
    const result = await extractAmsConfig(fixturePath);
    expect(result.useAms).toBe(true);
    expect(result.amsMapping).toEqual([0, 1, 2, 3]);
    expect(result.plateIndex).toBe(1);
    expect(result.subtaskName).toBe('multi-color');
  });
});

describe('extractAmsConfig — single-color (no AMS)', () => {
  it('returns safe defaults when slice_info.config has no <filament> tags', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
  </plate>
</config>`;
    const fixturePath = await writeZipWithSliceInfo('single.gcode.3mf', xml);
    const result = await extractAmsConfig(fixturePath);
    expect(result.useAms).toBe(false);
    expect(result.amsMapping).toEqual([]);
    expect(result.plateIndex).toBe(1);
    expect(result.subtaskName).toBe('single');
  });

  it('returns safe defaults when there is only a single <filament> (active material, not AMS)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <filament id="0" type="PLA" color="#FFFFFF"/>
  </plate>
</config>`;
    const fixturePath = await writeZipWithSliceInfo('one-filament.gcode.3mf', xml);
    const result = await extractAmsConfig(fixturePath);
    expect(result.useAms).toBe(false);
    expect(result.amsMapping).toEqual([]);
  });
});

describe('extractAmsConfig — malformed zip', () => {
  it('returns safe defaults without throwing', async () => {
    const fixturePath = path.join(tmpDir, 'garbage.gcode.3mf');
    await fs.writeFile(fixturePath, Buffer.from('this is not a zip file at all'));
    const result = await extractAmsConfig(fixturePath);
    expect(result).toEqual({
      useAms: false,
      amsMapping: [],
      plateIndex: 1,
      subtaskName: 'garbage',
    });
  });
});

describe('extractAmsConfig — missing slice_info.config', () => {
  it('returns safe defaults when the zip is valid but lacks Metadata/slice_info.config', async () => {
    const zip = new JSZip();
    zip.file('3D/3dmodel.model', '<?xml version="1.0"?><model/>');
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const fixturePath = path.join(tmpDir, 'no-metadata.gcode.3mf');
    await fs.writeFile(fixturePath, buf);
    const result = await extractAmsConfig(fixturePath);
    expect(result.useAms).toBe(false);
    expect(result.amsMapping).toEqual([]);
    expect(result.subtaskName).toBe('no-metadata');
  });
});

describe('extractAmsConfig — file not found', () => {
  it('returns safe defaults without throwing', async () => {
    const fixturePath = path.join(tmpDir, 'does-not-exist.gcode.3mf');
    const result = await extractAmsConfig(fixturePath);
    expect(result).toEqual({
      useAms: false,
      amsMapping: [],
      plateIndex: 1,
      subtaskName: 'does-not-exist',
    });
  });
});

describe('extractAmsConfig — subtaskName derivation', () => {
  it('strips .gcode.3mf suffix', async () => {
    const fixturePath = path.join(tmpDir, 'cube.gcode.3mf');
    // Path may not exist — function still returns defaults with the right name.
    const result = await extractAmsConfig(fixturePath);
    expect(result.subtaskName).toBe('cube');
  });

  it('strips .3mf suffix when no .gcode prefix', async () => {
    const fixturePath = path.join(tmpDir, 'multi-color.3mf');
    const result = await extractAmsConfig(fixturePath);
    expect(result.subtaskName).toBe('multi-color');
  });

  it('handles uppercase extensions case-insensitively', async () => {
    const fixturePath = path.join(tmpDir, 'PRINT.GCODE.3MF');
    const result = await extractAmsConfig(fixturePath);
    expect(result.subtaskName).toBe('PRINT');
  });
});
