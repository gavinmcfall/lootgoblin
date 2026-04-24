/**
 * Integration tests for file-watcher — V2-002-T4
 *
 * All tests run against the real filesystem under /tmp.
 * Each test gets its own unique scratch directory (created via mkdtemp).
 *
 * Chokidar events fire asynchronously, so every event assertion uses
 * `vi.waitFor` with a generous timeout (3 s), ensuring determinism without
 * relying on arbitrary sleeps.
 *
 * All watchers use:
 *   stabilityThresholdMs: 200   (debounce window)
 *   pollIntervalMs:       50    (write-finish poll)
 *
 * Test cases:
 *   1.  Lifecycle — start → ready → stop, no post-stop event leaks
 *   2.  Add event — new file written after start
 *   3.  Change event — existing file modified after start
 *   4.  Unlink event — file deleted after start
 *   5.  UnlinkDir event — subdirectory deleted after start
 *   6.  Multiple paths — watcher over 2 dirs, events from each
 *   7.  Ignored patterns — .DS_Store file is suppressed
 *   8.  emitInitialAdds: false — existing files produce no add events
 *   9.  emitInitialAdds: true  — existing files produce add events before ready
 *   10. Multiple subscribers — both receive; unsubscribe removes only one
 *   11. Debounce — rapid writes produce a SINGLE add event
 *   12. Stop is idempotent — calling stop() twice throws no error
 */

import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  vi,
} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileWatcher } from '../../src/stash/file-watcher';
import type { FileWatcher, WatcherEvent } from '../../src/stash/file-watcher';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Stability threshold applied in all tests. Keep short to avoid slow tests. */
const STABILITY_MS = 200;
/** Poll interval applied in all tests. */
const POLL_MS = 50;
/**
 * Generous budget for vi.waitFor: stability threshold + event propagation
 * overhead + some headroom.
 */
const WAIT_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Per-test scratch directory + watcher teardown
// ---------------------------------------------------------------------------

let scratch: string;
let watcherUnderTest: FileWatcher | null = null;

beforeEach(async () => {
  scratch = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'lootgoblin-fw-'),
  );
  watcherUnderTest = null;
});

afterEach(async () => {
  // Always stop the watcher (idempotent — safe even if already stopped or null)
  if (watcherUnderTest !== null) {
    await watcherUnderTest.stop();
    watcherUnderTest = null;
  }
  // Remove scratch directory and all contents
  await fs.promises.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a FileWatcher with the test-friendly short debounce settings.
 * Registers the watcher for auto-teardown in afterEach.
 */
function makeWatcher(
  paths: string[],
  overrides: Parameters<typeof createFileWatcher>[0] extends infer O
    ? Partial<Omit<O extends object ? O : never, 'paths'>>
    : never = {},
): FileWatcher {
  const watcher = createFileWatcher({
    paths,
    stabilityThresholdMs: STABILITY_MS,
    pollIntervalMs: POLL_MS,
    ...overrides,
  });
  watcherUnderTest = watcher;
  return watcher;
}

/**
 * Collect all events emitted to a watcher into an array for assertion.
 * Returns the events array (mutated in-place as events arrive).
 */
function collectEvents(watcher: FileWatcher): WatcherEvent[] {
  const events: WatcherEvent[] = [];
  watcher.onEvent((e) => events.push(e));
  return events;
}

/**
 * Write content to a file asynchronously.
 * Creates parent directories if missing.
 */
async function writeFile(filePath: string, content = 'test content\n'): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Test 1: Lifecycle
// ---------------------------------------------------------------------------

describe('FileWatcher — lifecycle', () => {
  it('start resolves, ready() resolves, stop releases without errors; no events leak after stop', async () => {
    const w = makeWatcher([scratch]);
    const events = collectEvents(w);

    await w.start();
    await w.ready();

    // Nothing happened yet — no events
    expect(events).toHaveLength(0);

    // Stop
    await w.stop();

    // Write a file after stop — should not produce any events
    await writeFile(path.join(scratch, 'post-stop.txt'));

    // Brief wait to confirm no leak
    await new Promise((r) => setTimeout(r, STABILITY_MS + POLL_MS * 2));

    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Add event
// ---------------------------------------------------------------------------

describe('FileWatcher — add event', () => {
  it('emits { kind: add, path, size, mtime } when a new file is written', async () => {
    const w = makeWatcher([scratch], { emitInitialAdds: false });
    const events = collectEvents(w);

    await w.start();
    await w.ready();

    const filePath = path.join(scratch, 'newfile.txt');
    await writeFile(filePath, 'hello watcher\n');

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({ kind: 'add', path: filePath }),
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    const addEvent = events.find((e) => e.kind === 'add' && e.path === filePath);
    expect(addEvent).toBeDefined();
    if (addEvent?.kind === 'add') {
      expect(addEvent.size).toBeGreaterThan(0);
      expect(addEvent.mtime).toBeInstanceOf(Date);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Change event
// ---------------------------------------------------------------------------

describe('FileWatcher — change event', () => {
  it('emits { kind: change, path, size, mtime } when an existing file is modified', async () => {
    const filePath = path.join(scratch, 'existing.txt');
    await writeFile(filePath, 'original content\n');

    const w = makeWatcher([scratch], { emitInitialAdds: false });
    const events = collectEvents(w);

    await w.start();
    await w.ready();

    // Modify the file
    await fs.promises.appendFile(filePath, 'appended content\n');

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({ kind: 'change', path: filePath }),
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    const changeEvent = events.find((e) => e.kind === 'change' && e.path === filePath);
    expect(changeEvent).toBeDefined();
    if (changeEvent?.kind === 'change') {
      expect(changeEvent.size).toBeGreaterThan(0);
      expect(changeEvent.mtime).toBeInstanceOf(Date);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: Unlink event
// ---------------------------------------------------------------------------

describe('FileWatcher — unlink event', () => {
  it('emits { kind: unlink, path } when a file is deleted', async () => {
    const filePath = path.join(scratch, 'to-delete.txt');
    await writeFile(filePath);

    const w = makeWatcher([scratch], { emitInitialAdds: false });
    const events = collectEvents(w);

    await w.start();
    await w.ready();

    await fs.promises.unlink(filePath);

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({ kind: 'unlink', path: filePath }),
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5: UnlinkDir event
// ---------------------------------------------------------------------------

describe('FileWatcher — unlinkDir event', () => {
  it('emits { kind: unlinkDir, path } when a subdirectory is removed', async () => {
    // Create a subdir inside scratch (chokidar watches recursively)
    const subdir = path.join(scratch, 'subdir-to-remove');
    await fs.promises.mkdir(subdir);
    // Put a file in it so the directory is non-empty, then remove it cleanly
    const fileInSubdir = path.join(subdir, 'file.txt');
    await writeFile(fileInSubdir);

    const w = makeWatcher([scratch], { emitInitialAdds: false });
    const events = collectEvents(w);

    await w.start();
    await w.ready();

    // Remove the file first, then the directory
    await fs.promises.unlink(fileInSubdir);
    await fs.promises.rmdir(subdir);

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({ kind: 'unlinkDir', path: subdir }),
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6: Multiple watched paths
// ---------------------------------------------------------------------------

describe('FileWatcher — multiple paths', () => {
  it('emits events for files created in each of two watched directories', async () => {
    const dirA = path.join(scratch, 'dir-a');
    const dirB = path.join(scratch, 'dir-b');
    await fs.promises.mkdir(dirA);
    await fs.promises.mkdir(dirB);

    const w = makeWatcher([dirA, dirB], { emitInitialAdds: false });
    const events = collectEvents(w);

    await w.start();
    await w.ready();

    const fileA = path.join(dirA, 'alpha.txt');
    const fileB = path.join(dirB, 'beta.txt');
    await writeFile(fileA);
    await writeFile(fileB);

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({ kind: 'add', path: fileA }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({ kind: 'add', path: fileB }),
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
  });
});

// ---------------------------------------------------------------------------
// Test 7: Ignored patterns
// ---------------------------------------------------------------------------

describe('FileWatcher — ignored patterns', () => {
  it('does NOT emit events for files matching the ignored RegExp', async () => {
    // NOTE: chokidar v4 changed ignored string semantics — strings are now
    // exact-path matches, NOT glob patterns. Use RegExp or function matchers
    // for pattern-based ignores. See learning #28 in V2-002 execution learnings.
    const w = makeWatcher([scratch], {
      ignored: [/\.DS_Store$/],
      emitInitialAdds: false,
    });
    const events = collectEvents(w);

    await w.start();
    await w.ready();

    const dsStore = path.join(scratch, '.DS_Store');
    const regularFile = path.join(scratch, 'not-ignored.txt');

    await writeFile(dsStore, 'DS_Store content\n');
    await writeFile(regularFile, 'visible content\n');

    // Wait for the regular file to appear (confirms the watcher is running)
    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({ kind: 'add', path: regularFile }),
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    // .DS_Store must never appear
    const dsStoreEvents = events.filter(
      (e) => 'path' in e && e.path === dsStore,
    );
    expect(dsStoreEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 8: emitInitialAdds: false
// ---------------------------------------------------------------------------

describe('FileWatcher — emitInitialAdds: false', () => {
  it('does NOT emit add events for files that existed before start()', async () => {
    // Create files BEFORE starting the watcher
    await writeFile(path.join(scratch, 'pre-existing-1.txt'));
    await writeFile(path.join(scratch, 'pre-existing-2.txt'));

    const w = makeWatcher([scratch], { emitInitialAdds: false });
    const events = collectEvents(w);

    await w.start();
    await w.ready();

    // After ready(), no add events for the pre-existing files
    const addEvents = events.filter((e) => e.kind === 'add');
    expect(addEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 9: emitInitialAdds: true
// ---------------------------------------------------------------------------

describe('FileWatcher — emitInitialAdds: true', () => {
  it('emits add events for every existing file, all delivered before ready() resolves', async () => {
    // Create files BEFORE starting the watcher
    const file1 = path.join(scratch, 'file1.stl');
    const file2 = path.join(scratch, 'file2.stl');
    await writeFile(file1, 'stl-content-1\n');
    await writeFile(file2, 'stl-content-2\n');

    const w = makeWatcher([scratch], { emitInitialAdds: true });
    const events = collectEvents(w);

    await w.start();
    // After start() returns, ready() should resolve shortly
    await w.ready();

    // By the time ready resolves, the initial adds must have been emitted
    const addPaths = events
      .filter((e) => e.kind === 'add')
      .map((e) => (e.kind === 'add' ? e.path : null))
      .filter(Boolean);

    expect(addPaths).toContain(file1);
    expect(addPaths).toContain(file2);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Multiple subscribers
// ---------------------------------------------------------------------------

describe('FileWatcher — multiple subscribers', () => {
  it('both listeners receive the event; unsubscribing one stops delivery to it only', async () => {
    const w = makeWatcher([scratch], { emitInitialAdds: false });

    const eventsA: WatcherEvent[] = [];
    const eventsB: WatcherEvent[] = [];

    const unsubA = w.onEvent((e) => eventsA.push(e));
    w.onEvent((e) => eventsB.push(e));

    await w.start();
    await w.ready();

    // First file — both listeners should receive
    const file1 = path.join(scratch, 'first.txt');
    await writeFile(file1);

    await vi.waitFor(
      () => {
        expect(eventsA).toContainEqual(
          expect.objectContaining({ kind: 'add', path: file1 }),
        );
        expect(eventsB).toContainEqual(
          expect.objectContaining({ kind: 'add', path: file1 }),
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    // Unsubscribe A
    unsubA();

    const countABeforeSecond = eventsA.length;

    // Second file — only B should receive
    const file2 = path.join(scratch, 'second.txt');
    await writeFile(file2);

    await vi.waitFor(
      () => {
        expect(eventsB).toContainEqual(
          expect.objectContaining({ kind: 'add', path: file2 }),
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    // A must NOT have received the second file event
    expect(eventsA).toHaveLength(countABeforeSecond);
  });
});

// ---------------------------------------------------------------------------
// Test 11: Debounce — rapid writes produce a single event
// ---------------------------------------------------------------------------

describe('FileWatcher — debounce (awaitWriteFinish)', () => {
  it('produces a SINGLE add event for a file written in multiple rapid chunks', async () => {
    const w = makeWatcher([scratch], { emitInitialAdds: false });
    const events = collectEvents(w);

    await w.start();
    await w.ready();

    const filePath = path.join(scratch, 'chunked.bin');

    // Open the file and write small chunks rapidly, faster than STABILITY_MS.
    // This simulates a write-in-progress that chokidar should debounce.
    const handle = await fs.promises.open(filePath, 'w');
    const chunkCount = 5;
    for (let i = 0; i < chunkCount; i++) {
      await handle.write(`chunk-${i}\n`);
      // Small delay between chunks — much less than stabilityThresholdMs
      await new Promise((r) => setTimeout(r, 20));
    }
    await handle.close();

    // Wait for the single stabilized add event
    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({ kind: 'add', path: filePath }),
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    // Count how many add events fired for this specific path
    const addEventsForPath = events.filter(
      (e) => e.kind === 'add' && e.path === filePath,
    );
    expect(addEventsForPath).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Stop is idempotent
// ---------------------------------------------------------------------------

describe('FileWatcher — stop is idempotent', () => {
  it('calling stop() twice does not throw', async () => {
    const w = makeWatcher([scratch]);

    await w.start();
    await w.ready();

    // First stop
    await expect(w.stop()).resolves.toBeUndefined();

    // Second stop — must not throw
    await expect(w.stop()).resolves.toBeUndefined();
  });
});
