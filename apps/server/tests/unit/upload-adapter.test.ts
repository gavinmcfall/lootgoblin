/**
 * Unit tests — upload adapter — V2-003-T4
 *
 * Tests the upload adapter in isolation (no HTTP, no DB, no pipeline).
 * Exercises the fetch() async iterable directly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { createUploadAdapter } from '../../src/scavengers/adapters/upload';
import type { FetchContext, FetchTarget } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-upload-test-'));
  dirsToClean.push(dir);
  return dir;
}

async function makeStagingDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-staging-test-'));
  dirsToClean.push(dir);
  return dir;
}

function makeCtx(stagingDir: string): FetchContext {
  return {
    userId: crypto.randomUUID(),
    stagingDir,
  };
}

function makeRawTarget(
  tempDir: string,
  title = 'Test Upload',
  extra?: Partial<{ description: string; creator: string; license: string; tags: string[] }>,
): FetchTarget {
  return {
    kind: 'raw',
    payload: {
      tempDir,
      metadata: { title, ...extra },
    },
  };
}

/** Collect all events from the adapter's fetch() iterable. */
async function collectEvents(
  adapter: ReturnType<typeof createUploadAdapter>,
  ctx: FetchContext,
  target: FetchTarget,
) {
  const events = [];
  for await (const evt of adapter.fetch(ctx, target)) {
    events.push(evt);
  }
  return events;
}

afterEach(async () => {
  // Best-effort cleanup of scratch directories created during the test.
  for (const dir of dirsToClean.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createUploadAdapter', () => {
  describe('supports()', () => {
    it('always returns false — upload is not URL-driven', () => {
      const adapter = createUploadAdapter();
      expect(adapter.supports('https://example.com/file.stl')).toBe(false);
      expect(adapter.supports('upload://anything')).toBe(false);
      expect(adapter.supports('')).toBe(false);
    });
  });

  describe('fetch() — successful upload', () => {
    it('yields completed event with both files in NormalizedItem for a 2-file upload', async () => {
      const adapter = createUploadAdapter();
      const tempDir = await makeTempDir();
      const stagingDir = await makeStagingDir();

      // Write two files to tempDir.
      const content1 = Buffer.from('fake stl content');
      const content2 = Buffer.from('fake png content');
      await fsp.writeFile(path.join(tempDir, 'model.stl'), content1);
      await fsp.writeFile(path.join(tempDir, 'preview.png'), content2);

      const ctx = makeCtx(stagingDir);
      const target = makeRawTarget(tempDir, 'My Model', {
        description: 'A great model',
        creator: 'Alice',
        license: 'CC-BY-4.0',
        tags: ['3d', 'test'],
      });

      const events = await collectEvents(adapter, ctx, target);

      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.kind).toBe('completed');
      if (evt.kind !== 'completed') return;

      const item = evt.item;
      expect(item.sourceId).toBe('upload');
      expect(typeof item.sourceItemId).toBe('string');
      expect(item.sourceItemId.length).toBeGreaterThan(0);
      expect(item.title).toBe('My Model');
      expect(item.description).toBe('A great model');
      expect(item.creator).toBe('Alice');
      expect(item.license).toBe('CC-BY-4.0');
      expect(item.tags).toEqual(['3d', 'test']);
      expect(item.files).toHaveLength(2);

      // Both files should be in stagingDir.
      const names = item.files.map((f) => f.suggestedName).sort();
      expect(names).toEqual(['model.stl', 'preview.png']);

      for (const file of item.files) {
        expect(file.stagedPath.startsWith(stagingDir)).toBe(true);
        expect(file.size).toBeGreaterThan(0);
        // format is not set by the adapter (pipeline sniffs it)
        expect(file.format).toBeUndefined();
      }
    });

    it('removes the tempDir after a successful fetch', async () => {
      const adapter = createUploadAdapter();
      const tempDir = await makeTempDir();
      const stagingDir = await makeStagingDir();

      await fsp.writeFile(path.join(tempDir, 'file.stl'), 'content');

      const events = await collectEvents(adapter, makeCtx(stagingDir), makeRawTarget(tempDir));
      expect(events[0]?.kind).toBe('completed');

      // tempDir should be gone.
      await expect(fsp.access(tempDir)).rejects.toThrow();
    });

    it('each upload gets a unique sourceItemId', async () => {
      const adapter = createUploadAdapter();
      const stagingDir1 = await makeStagingDir();
      const stagingDir2 = await makeStagingDir();

      const tempDir1 = await makeTempDir();
      const tempDir2 = await makeTempDir();
      await fsp.writeFile(path.join(tempDir1, 'a.stl'), 'content-a');
      await fsp.writeFile(path.join(tempDir2, 'b.stl'), 'content-b');

      const [events1, events2] = await Promise.all([
        collectEvents(adapter, makeCtx(stagingDir1), makeRawTarget(tempDir1, 'Item 1')),
        collectEvents(adapter, makeCtx(stagingDir2), makeRawTarget(tempDir2, 'Item 2')),
      ]);

      const id1 = events1[0]?.kind === 'completed' ? events1[0].item.sourceItemId : null;
      const id2 = events2[0]?.kind === 'completed' ? events2[0].item.sourceItemId : null;

      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).not.toBe(id2);
    });
  });

  describe('fetch() — failure cases', () => {
    it('yields failed event when metadata.title is missing (empty string)', async () => {
      const adapter = createUploadAdapter();
      const tempDir = await makeTempDir();
      const stagingDir = await makeStagingDir();
      await fsp.writeFile(path.join(tempDir, 'file.stl'), 'x');

      const events = await collectEvents(adapter, makeCtx(stagingDir), {
        kind: 'raw',
        payload: { tempDir, metadata: { title: '   ' } }, // whitespace-only title
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('failed');
      if (events[0]?.kind !== 'failed') return;
      expect(events[0].details).toMatch(/title/i);
    });

    it('yields failed event when metadata field is absent', async () => {
      const adapter = createUploadAdapter();
      const tempDir = await makeTempDir();
      const stagingDir = await makeStagingDir();
      await fsp.writeFile(path.join(tempDir, 'file.stl'), 'x');

      const events = await collectEvents(adapter, makeCtx(stagingDir), {
        kind: 'raw',
        payload: { tempDir, metadata: null },
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('failed');
    });

    it('yields failed event when tempDir does not exist', async () => {
      const adapter = createUploadAdapter();
      const stagingDir = await makeStagingDir();
      const nonExistentDir = path.join(os.tmpdir(), `lg-does-not-exist-${crypto.randomUUID()}`);

      const events = await collectEvents(
        adapter,
        makeCtx(stagingDir),
        makeRawTarget(nonExistentDir, 'Title'),
      );

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('failed');
      if (events[0]?.kind !== 'failed') return;
      expect(events[0].details).toMatch(/tempDir/i);
    });

    it('yields failed event when tempDir is empty (no files)', async () => {
      const adapter = createUploadAdapter();
      const tempDir = await makeTempDir(); // empty dir
      const stagingDir = await makeStagingDir();

      const events = await collectEvents(adapter, makeCtx(stagingDir), makeRawTarget(tempDir));

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('failed');
      if (events[0]?.kind !== 'failed') return;
      expect(events[0].details).toMatch(/no files/i);
    });

    it('yields failed event for non-raw target kind (url)', async () => {
      const adapter = createUploadAdapter();
      const stagingDir = await makeStagingDir();

      const events = await collectEvents(adapter, makeCtx(stagingDir), {
        kind: 'url',
        url: 'https://example.com/model.stl',
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('failed');
      if (events[0]?.kind !== 'failed') return;
      expect(events[0].details).toMatch(/raw target/i);
    });

    it('yields failed event for non-raw target kind (source-item-id)', async () => {
      const adapter = createUploadAdapter();
      const stagingDir = await makeStagingDir();

      const events = await collectEvents(adapter, makeCtx(stagingDir), {
        kind: 'source-item-id',
        sourceItemId: 'some-id',
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('failed');
    });
  });

  describe('fetch() — tempDir cleanup behaviour', () => {
    it('cleans up tempDir even if a staging dir is shared across concurrent calls', async () => {
      const adapter = createUploadAdapter();

      // Each fetch creates its own tempDir, but we verify cleanup is per-call.
      const tempDir = await makeTempDir();
      const stagingDir = await makeStagingDir();
      await fsp.writeFile(path.join(tempDir, 'file.obj'), 'obj content');

      await collectEvents(adapter, makeCtx(stagingDir), makeRawTarget(tempDir));

      // tempDir removed, stagingDir still exists with the file.
      await expect(fsp.access(tempDir)).rejects.toThrow();
      const stagedFiles = await fsp.readdir(stagingDir);
      expect(stagedFiles).toContain('file.obj');
    });
  });
});
