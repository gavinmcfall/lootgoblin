/**
 * Unit tests — status-event-handler — V2-005f-T_dcf10.
 *
 * Coverage:
 *   1.  Persists non-terminal event (progress) — INSERT + cache update,
 *       status stays 'dispatched'
 *   2.  Persists + transitions on completed — status → completed, pct=100,
 *       emitConsumption called, notifyTerminal called
 *   3.  Persists + transitions on failed — status → failed,
 *       reason='target-rejected', emitConsumption NOT called
 *   4.  Idempotent terminal — second completed event logs warn but doesn't
 *       throw, no second emitConsumption
 *   5.  No matching dispatch — info-log, no DB writes
 *   6.  Correlate via remoteJobRef — picks the dispatch whose sliced/converted
 *       file basename matches; the other stays
 *   7.  Correlate without remoteJobRef — picks most recent
 *   8.  derivePrinterProtocol covers every FORGE_PRINTER_KIND
 *   9.  emitToBus called for every event (non-terminal + terminal)
 *  10.  measuredConsumption serialized into event_data JSON
 *  11.  Failed event with measuredConsumption — payload preserved BUT
 *       emitConsumption NOT called
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import {
  runMigrations,
  resetDbCache,
  getDb,
} from '../../src/db/client';
import * as schema from '../../src/db/schema';
import { FORGE_PRINTER_KINDS } from '../../src/db/schema.forge';
import {
  createStatusEventSink,
  derivePrinterProtocol,
  correlateDispatchByPrinter,
} from '../../src/forge/status/status-event-handler';
import type { StatusEvent } from '../../src/forge/status/types';

const DB_PATH = '/tmp/lootgoblin-status-event-handler.db';
const DB_URL = `file:${DB_PATH}`;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET ??= 'a'.repeat(32);
  await runMigrations(DB_URL);
}, 30_000);

beforeEach(() => {
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
});

afterEach(async () => {
  const db = getDb(DB_URL) as any;
  await db.delete(schema.dispatchStatusEvents);
  await db.delete(schema.dispatchJobs);
  await db.delete(schema.lootFiles);
  await db.delete(schema.printers);
  await db.delete(schema.loot);
  await db.delete(schema.collections);
  await db.delete(schema.stashRoots);
  await db.delete(schema.user);
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

async function seedUser(): Promise<string> {
  const db = getDb(DB_URL) as any;
  const id = uid('u');
  await db.insert(schema.user).values({
    id,
    name: 'status-handler test user',
    email: `${id}@status-handler.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(
  ownerId: string,
  kind: string = 'fdm_klipper',
): Promise<string> {
  const db = getDb(DB_URL) as any;
  const id = uid('p');
  await db.insert(schema.printers).values({
    id,
    ownerId,
    kind,
    name: `printer-${id.slice(0, 6)}`,
    connectionConfig: { url: 'http://1.2.3.4:7125' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

interface SeedDispatchOpts {
  ownerId: string;
  printerId: string;
  status?:
    | 'pending'
    | 'converting'
    | 'slicing'
    | 'claimable'
    | 'claimed'
    | 'dispatched'
    | 'completed'
    | 'failed';
  remoteFilename?: string;
  /** Force a creation timestamp — older first. */
  createdAt?: Date;
}

async function seedDispatch(opts: SeedDispatchOpts): Promise<{
  jobId: string;
  slicedFileId: string | null;
}> {
  const db = getDb(DB_URL) as any;
  const userId = opts.ownerId;
  const rootPath = `/tmp/lg-sh-${randomUUID().slice(0, 8)}`;
  const rootId = uid('r');
  const collectionId = uid('c');
  const lootId = uid('l');
  const jobId = uid('j');

  await db.insert(schema.stashRoots).values({
    id: rootId,
    ownerId: userId,
    name: 'root',
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.collections).values({
    id: collectionId,
    ownerId: userId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'cube',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  let slicedFileId: string | null = null;
  if (opts.remoteFilename) {
    slicedFileId = uid('lf');
    await db.insert(schema.lootFiles).values({
      id: slicedFileId,
      lootId,
      path: `Brand/Color/${opts.remoteFilename}`,
      format: 'gcode',
      size: 1024,
      hash: 'a'.repeat(64),
      origin: 'manual',
      createdAt: new Date(),
    });
  }

  await db.insert(schema.dispatchJobs).values({
    id: jobId,
    ownerId: userId,
    lootId,
    targetKind: 'printer',
    targetId: opts.printerId,
    status: opts.status ?? 'dispatched',
    slicedFileId,
    createdAt: opts.createdAt ?? new Date(),
  });

  return { jobId, slicedFileId };
}

function progressEvent(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    kind: 'progress',
    remoteJobRef: '',
    progressPct: 42,
    rawPayload: { gcodeState: 'PRINTING' },
    occurredAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  };
}

function completedEvent(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    kind: 'completed',
    remoteJobRef: '',
    progressPct: 100,
    rawPayload: { gcodeState: 'FINISH' },
    occurredAt: new Date('2026-05-01T00:30:00Z'),
    ...overrides,
  };
}

function failedEvent(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    kind: 'failed',
    remoteJobRef: '',
    rawPayload: { errorCode: 'ERR_THERMAL', gcodeState: 'FAILED' },
    occurredAt: new Date('2026-05-01T00:15:00Z'),
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('status-event-handler — V2-005f-T_dcf10', () => {
  it('1. persists non-terminal event + updates cache, status stays dispatched', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const { jobId } = await seedDispatch({ ownerId, printerId });

    const sink = createStatusEventSink({ dbUrl: DB_URL });
    await sink(printerId, progressEvent({ progressPct: 42 }));

    const db = getDb(DB_URL) as any;
    const events = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, jobId));
    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe('progress');
    expect(events[0].sourceProtocol).toBe('moonraker');
    const eventData = JSON.parse(events[0].eventData);
    expect(eventData.progressPct).toBe(42);

    const jobRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(jobRows[0].status).toBe('dispatched');
    expect(jobRows[0].progressPct).toBe(42);
    expect(jobRows[0].lastStatusAt).not.toBeNull();
  });

  it('2. completed event transitions to completed, sets pct=100, fires emitConsumption + notifyTerminal', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const { jobId } = await seedDispatch({ ownerId, printerId });

    const consumptionCalls: Array<{ dispatchJobId: string; event: StatusEvent }> = [];
    const terminalCalls: Array<{ dispatchJobId: string; printerId: string }> = [];
    const busCalls: Array<{ dispatchJobId: string; event: StatusEvent }> = [];

    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        emitConsumption: (a) => {
          consumptionCalls.push(a);
        },
        notifyTerminal: (a) => {
          terminalCalls.push(a);
        },
        emitToBus: (id, ev) => {
          busCalls.push({ dispatchJobId: id, event: ev });
        },
      },
    });

    await sink(printerId, completedEvent());

    const db = getDb(DB_URL) as any;
    const jobRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(jobRows[0].status).toBe('completed');
    expect(jobRows[0].progressPct).toBe(100);
    expect(jobRows[0].completedAt).not.toBeNull();

    expect(consumptionCalls).toHaveLength(1);
    expect(consumptionCalls[0].dispatchJobId).toBe(jobId);
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0]).toEqual({ dispatchJobId: jobId, printerId });
    expect(busCalls).toHaveLength(1);
  });

  it('3. failed event transitions to failed (target-rejected), emitConsumption NOT called', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const { jobId } = await seedDispatch({ ownerId, printerId });

    const consumptionCalls: number[] = [];
    const terminalCalls: number[] = [];
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        emitConsumption: () => {
          consumptionCalls.push(1);
        },
        notifyTerminal: () => {
          terminalCalls.push(1);
        },
      },
    });

    await sink(printerId, failedEvent());

    const db = getDb(DB_URL) as any;
    const jobRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(jobRows[0].status).toBe('failed');
    expect(jobRows[0].failureReason).toBe('target-rejected');
    expect(jobRows[0].failureDetails).toContain('ERR_THERMAL');
    expect(consumptionCalls).toHaveLength(0);
    expect(terminalCalls).toHaveLength(1);
  });

  it('4. duplicate completed event tolerated; no double emitConsumption', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const { jobId } = await seedDispatch({ ownerId, printerId });

    const consumptionCalls: number[] = [];
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        emitConsumption: () => {
          consumptionCalls.push(1);
        },
      },
    });

    await sink(printerId, completedEvent());
    await sink(printerId, completedEvent()); // second time

    expect(consumptionCalls).toHaveLength(1);

    const db = getDb(DB_URL) as any;
    const jobRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(jobRows[0].status).toBe('completed');

    // Second event still left an audit trail. After first completed event the
    // dispatch is in 'completed' state; correlation only matches dispatched/
    // claimed jobs, so the second event drops cleanly with no DB writes.
    const events = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, jobId));
    expect(events).toHaveLength(1);
  });

  it('5. no matching dispatch on printer → info-log + no DB writes', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    // No dispatch_jobs seeded for this printer.

    const consumptionCalls: number[] = [];
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: { emitConsumption: () => consumptionCalls.push(1) },
    });

    await sink(printerId, progressEvent());

    const db = getDb(DB_URL) as any;
    const events = await db.select().from(schema.dispatchStatusEvents);
    expect(events).toHaveLength(0);
    expect(consumptionCalls).toHaveLength(0);
  });

  it('6. correlate by remoteJobRef picks matching basename', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    const olderTime = new Date('2026-04-30T00:00:00Z');
    const newerTime = new Date('2026-04-30T01:00:00Z');

    const olderJob = await seedDispatch({
      ownerId,
      printerId,
      remoteFilename: 'cube-A.gcode',
      createdAt: olderTime,
    });
    const newerJob = await seedDispatch({
      ownerId,
      printerId,
      remoteFilename: 'cube-B.gcode',
      createdAt: newerTime,
    });

    const sink = createStatusEventSink({ dbUrl: DB_URL });

    // Send a completed event whose remoteJobRef matches the OLDER job's
    // sliced filename. The default correlator should pick the older one
    // even though the newer is more recent.
    await sink(
      printerId,
      completedEvent({ remoteJobRef: 'cube-A.gcode' }),
    );

    const db = getDb(DB_URL) as any;
    const olderRow = (
      await db
        .select()
        .from(schema.dispatchJobs)
        .where(eq(schema.dispatchJobs.id, olderJob.jobId))
    )[0];
    const newerRow = (
      await db
        .select()
        .from(schema.dispatchJobs)
        .where(eq(schema.dispatchJobs.id, newerJob.jobId))
    )[0];
    expect(olderRow.status).toBe('completed');
    expect(newerRow.status).toBe('dispatched');
  });

  it('7. correlate without remoteJobRef picks most-recent dispatched', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const olderTime = new Date('2026-04-29T00:00:00Z');
    const newerTime = new Date('2026-04-30T00:00:00Z');

    const older = await seedDispatch({
      ownerId,
      printerId,
      createdAt: olderTime,
    });
    const newer = await seedDispatch({
      ownerId,
      printerId,
      createdAt: newerTime,
    });

    const result = await correlateDispatchByPrinter({
      printerId,
      remoteJobRef: '',
      dbUrl: DB_URL,
    });
    expect(result).toBe(newer.jobId);
    expect(result).not.toBe(older.jobId);
  });

  it('8. derivePrinterProtocol covers every FORGE_PRINTER_KIND', () => {
    for (const kind of FORGE_PRINTER_KINDS) {
      const result = derivePrinterProtocol(kind);
      expect(result, `kind=${kind}`).not.toBeNull();
      expect(
        ['moonraker', 'octoprint', 'bambu_lan', 'sdcp', 'chitu_network'],
      ).toContain(result);
    }
  });

  it('9. emitToBus is called for every event (non-terminal + terminal)', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const { jobId } = await seedDispatch({ ownerId, printerId });

    const busCalls: Array<{ dispatchJobId: string; event: StatusEvent }> = [];
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        emitToBus: (id, ev) => busCalls.push({ dispatchJobId: id, event: ev }),
      },
    });

    await sink(printerId, progressEvent({ progressPct: 10 }));
    await sink(printerId, progressEvent({ progressPct: 50 }));
    await sink(printerId, completedEvent());

    expect(busCalls).toHaveLength(3);
    for (const call of busCalls) {
      expect(call.dispatchJobId).toBe(jobId);
    }
    expect(busCalls.map((c) => c.event.kind)).toEqual([
      'progress',
      'progress',
      'completed',
    ]);
  });

  it('10. measuredConsumption is serialized into event_data JSON', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId, 'bambu_x1c');
    const { jobId } = await seedDispatch({ ownerId, printerId });

    const sink = createStatusEventSink({ dbUrl: DB_URL });
    await sink(
      printerId,
      completedEvent({
        measuredConsumption: [
          { slot_index: 0, grams: 12.3, volume_ml: 4.1 },
          { slot_index: 1, grams: 6.7, remain_percent: 80 },
        ],
      }),
    );

    const db = getDb(DB_URL) as any;
    const events = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, jobId));
    expect(events).toHaveLength(1);
    expect(events[0].sourceProtocol).toBe('bambu_lan');
    const data = JSON.parse(events[0].eventData);
    expect(data.measuredConsumption).toHaveLength(2);
    expect(data.measuredConsumption[0]).toEqual({
      slot_index: 0,
      grams: 12.3,
      volume_ml: 4.1,
    });
    expect(data.measuredConsumption[1]).toEqual({
      slot_index: 1,
      grams: 6.7,
      remain_percent: 80,
    });
  });

  it('11. failed event with measuredConsumption preserves payload but does NOT emit consumption', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId, 'bambu_x1c');
    const { jobId } = await seedDispatch({ ownerId, printerId });

    const consumptionCalls: number[] = [];
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: { emitConsumption: () => consumptionCalls.push(1) },
    });

    await sink(
      printerId,
      failedEvent({
        measuredConsumption: [{ slot_index: 0, grams: 5.5 }],
      }),
    );

    expect(consumptionCalls).toHaveLength(0);

    const db = getDb(DB_URL) as any;
    const events = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, jobId));
    expect(events).toHaveLength(1);
    const data = JSON.parse(events[0].eventData);
    expect(data.measuredConsumption).toEqual([{ slot_index: 0, grams: 5.5 }]);

    const jobRows = await db
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(jobRows[0].status).toBe('failed');
  });
});
