import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { filesystemWriter } from '../../src/destinations/filesystem';

describe('filesystem destination', () => {
  let staging: string;
  let output: string;

  beforeEach(async () => {
    staging = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-stage-'));
    output = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-out-'));
    await fs.writeFile(path.join(staging, 'model.stl'), 'binary');
    await fs.writeFile(path.join(staging, 'datapackage.json'), '{}');
  });

  it('atomic-moves staging into destination per template', async () => {
    const res = await filesystemWriter.write(staging, {
      id: 'd1', type: 'filesystem',
      config: { path: output, namingTemplate: '{designer}/{title}' },
      packager: 'manyfold-v0',
    }, { item: { designer: { name: 'Bulk' }, title: 'Hero' } as never });
    expect(res.outputPath).toBe(path.join(output, 'Bulk/Hero'));
    const files = await fs.readdir(res.outputPath);
    expect(files).toContain('model.stl');
    expect(files).toContain('datapackage.json');
    await expect(fs.stat(staging)).rejects.toThrow();
  });
});
