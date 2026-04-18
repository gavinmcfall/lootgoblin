import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { manyfoldV0 } from '../../src/packagers/manyfold-v0';
import schemaJson from '../../src/packagers/manyfold-v0/datapackage.schema.json';

const schema = schemaJson as object;

const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

describe('manyfold-v0 packager', () => {
  let staging: string;
  beforeEach(async () => {
    staging = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-pkg-'));
  });

  it('writes datapackage.json + files into staging', async () => {
    await manyfoldV0.package(staging, {
      sourceItemId: '123',
      title: 'Hero Bust',
      description: 'A bust',
      designer: { name: 'Bulk', profileUrl: 'https://makerworld.com/@bulk' },
      collection: undefined,
      tags: ['bust', 'hero'],
      license: 'CC-BY-4.0',
      sourceUrl: 'https://makerworld.com/models/123',
      thumbnailUrl: 'https://cdn/img.jpg',
      images: [{ name: 'img', url: 'https://cdn/img.jpg' }],
      files: [{ name: 'model.stl', mediaType: 'model/stl', stream: Readable.from(Buffer.from('BINARY')) }],
    });
    const pkg = JSON.parse(await fs.readFile(path.join(staging, 'datapackage.json'), 'utf8'));
    expect(pkg.$schema).toContain('manyfold.app');
    expect(pkg.title).toBe('Hero Bust');
    expect(pkg.contributors?.[0]?.title).toBe('Bulk');
    expect(validate(pkg)).toBe(true);
    const files = await fs.readdir(staging);
    expect(files).toContain('model.stl');
    expect(files).toContain('datapackage.json');
  });
});
