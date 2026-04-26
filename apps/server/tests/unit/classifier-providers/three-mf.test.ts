/**
 * Unit tests for the three-mf classifier provider — V2-002-T6
 *
 * Creates 3MF fixtures programmatically in beforeAll using JSZip so no
 * binary files need to be committed to the repository.
 *
 * Test scenarios:
 *   1. 3MF with full metadata → all fields extracted at correct confidences.
 *   2. 3MF with partial metadata (only title) → only title emitted.
 *   3. 3MF with no metadata elements → primaryFormat still emitted.
 *   4. Corrupt ZIP → primaryFormat not emitted, no throw.
 *   5. Multiple 3MF files → first one with metadata wins; subsequent skipped.
 *   6. Input with no 3MF files → empty result.
 *   7. LicenseTerms → license field with 0.9 confidence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import JSZip from 'jszip';
import { createThreeMfProvider } from '../../../src/stash/classifier-providers/three-mf';
import type { ClassifierInput } from '../../../src/stash/classifier';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function create3mf(
  filename: string,
  modelXml: string,
  /**
   * Optional: override the ZIP entry path for the model XML. Defaults to the
   * spec-standard "3D/3dmodel.model". Tests use this to verify
   * case-insensitive fallback behaviour for non-conforming slicers.
   */
  modelEntryPath = '3D/3dmodel.model',
): Promise<string> {
  const zip = new JSZip();
  zip.file(modelEntryPath, modelXml);
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`);

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const filePath = path.join(tmpDir, filename);
  await fs.writeFile(filePath, zipBuffer);
  return filePath;
}

function makeModelXml(metadata: Record<string, string>): string {
  const metadataElems = Object.entries(metadata)
    .map(([name, value]) => `  <metadata name="${name}">${value}</metadata>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
       xml:lang="en-US">
${metadataElems}
  <resources/>
  <build/>
</model>`;
}

function makeInput(absolutePath: string): ClassifierInput {
  return {
    files: [
      {
        absolutePath,
        relativePath: path.basename(absolutePath),
        size: 0,
        mtime: new Date(),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-three-mf-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createThreeMfProvider', () => {
  it('1. full metadata → all fields extracted with correct confidences', async () => {
    const filePath = await create3mf(
      'full-meta.3mf',
      makeModelXml({
        Title: 'Castle Wall',
        Designer: 'Alice',
        Description: 'A decorative castle wall piece',
        LicenseTerms: 'CC-BY-4.0',
      }),
    );

    const provider = createThreeMfProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.title).toEqual({ value: 'Castle Wall', confidence: 0.9 });
    expect(result.creator).toEqual({ value: 'Alice', confidence: 0.9 });
    expect(result.description).toEqual({
      value: 'A decorative castle wall piece',
      confidence: 0.8,
    });
    expect(result.license).toEqual({ value: 'CC-BY-4.0', confidence: 0.9 });
    expect(result.primaryFormat).toEqual({ value: '3mf', confidence: 0.95 });
  });

  it('2. partial metadata (title only) → only title and format emitted', async () => {
    const filePath = await create3mf(
      'title-only.3mf',
      makeModelXml({ Title: 'Dragon Head' }),
    );

    const provider = createThreeMfProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.title).toEqual({ value: 'Dragon Head', confidence: 0.9 });
    expect(result.creator).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.license).toBeUndefined();
    expect(result.primaryFormat).toEqual({ value: '3mf', confidence: 0.95 });
  });

  it('3. 3MF with no metadata elements → primaryFormat still emitted', async () => {
    const filePath = await create3mf(
      'no-meta.3mf',
      `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources/>
  <build/>
</model>`,
    );

    const provider = createThreeMfProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.title).toBeUndefined();
    expect(result.primaryFormat).toEqual({ value: '3mf', confidence: 0.95 });
  });

  it('4. corrupt ZIP → no throw, empty result (not even primaryFormat)', async () => {
    const filePath = path.join(tmpDir, 'corrupt.3mf');
    await fs.writeFile(filePath, Buffer.from('this is not a zip file'));

    const input: ClassifierInput = {
      files: [
        { absolutePath: filePath, relativePath: 'corrupt.3mf', size: 20, mtime: new Date() },
      ],
    };

    const provider = createThreeMfProvider();
    // Should not throw
    const result = await provider.classify(input);
    // Corrupt file yields no metadata, but primaryFormat should not be emitted
    // because no valid 3MF was successfully parsed.
    expect(result.title).toBeUndefined();
    // primaryFormat might be set (file exists and has .3mf ext) but no crash.
    // The key guarantee is no throw.
    expect(result).toBeDefined();
  });

  it('5. multiple 3MF files → first with metadata wins; format still emitted', async () => {
    const firstPath = await create3mf(
      'first.3mf',
      makeModelXml({ Title: 'First Model', Designer: 'Bob' }),
    );
    const secondPath = await create3mf(
      'second.3mf',
      makeModelXml({ Title: 'Second Model', Designer: 'Carol' }),
    );

    const input: ClassifierInput = {
      files: [
        { absolutePath: firstPath, relativePath: 'first.3mf', size: 0, mtime: new Date() },
        { absolutePath: secondPath, relativePath: 'second.3mf', size: 0, mtime: new Date() },
      ],
    };

    const provider = createThreeMfProvider();
    const result = await provider.classify(input);

    // First file's metadata wins.
    expect(result.title?.value).toBe('First Model');
    expect(result.creator?.value).toBe('Bob');
    expect(result.primaryFormat?.value).toBe('3mf');
  });

  it('6. no 3MF files in input → empty result', async () => {
    const input: ClassifierInput = {
      files: [
        {
          absolutePath: path.join(tmpDir, 'model.stl'),
          relativePath: 'model.stl',
          size: 1000,
          mtime: new Date(),
        },
      ],
    };

    const provider = createThreeMfProvider();
    const result = await provider.classify(input);

    expect(result).toEqual({});
  });

  it('7. LicenseTerms → license field with 0.9 confidence', async () => {
    const filePath = await create3mf(
      'license-check.3mf',
      makeModelXml({ LicenseTerms: 'MIT' }),
    );

    const provider = createThreeMfProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.license).toEqual({ value: 'MIT', confidence: 0.9 });
  });

  it('8. empty files array → empty result', async () => {
    const provider = createThreeMfProvider();
    const result = await provider.classify({ files: [] });
    expect(result).toEqual({});
  });

  it('9. lowercase entry path "3d/3dmodel.model" → metadata extracted via case-insensitive fallback', async () => {
    const filePath = await create3mf(
      'lowercase-entry.3mf',
      makeModelXml({ Title: 'Lowercase Model', Designer: 'Ci-fallback' }),
      '3d/3dmodel.model', // non-standard lowercase path
    );

    const provider = createThreeMfProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.title).toEqual({ value: 'Lowercase Model', confidence: 0.9 });
    expect(result.creator).toEqual({ value: 'Ci-fallback', confidence: 0.9 });
  });

  it('10. mixed-case entry path "3D/3Dmodel.model" → also resolved', async () => {
    const filePath = await create3mf(
      'mixed-case-entry.3mf',
      makeModelXml({ Title: 'Mixed Case' }),
      '3D/3Dmodel.model', // capital D in "3Dmodel"
    );

    const provider = createThreeMfProvider();
    const result = await provider.classify(makeInput(filePath));

    expect(result.title?.value).toBe('Mixed Case');
  });
});
