/**
 * Consumption reports integration test — V2-007a-T13.
 *
 * Seeds:
 *   - 3 users (verifies owner-scoping).
 *   - 4 materials per user (different brands, colors, units, printer-load
 *     state) plus an unbranded / un-colored / un-loaded material to cover
 *     the null-bucket cases.
 *   - ~10 consumption events per user spanning 30 days, mixing print-output
 *     and waste outcomes, with varied provenance classes.
 *   - 2 recycle events for the focal user with both tracked and untracked
 *     inputs, exercising the recycle bucket of `consumptionByOutcome`.
 *
 * Uses real `createMaterial` + `handleMaterialConsumed` + `applyRecycleEvent`
 * so the test exercises the actual code paths that feed the reports. No
 * direct ledger-event INSERTs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getServerDb, schema } from '../../src/db/client';
import { createMaterial, loadInPrinter } from '../../src/materials/lifecycle';
import { handleMaterialConsumed } from '../../src/materials/consumption';
import { applyRecycleEvent } from '../../src/materials/recycle';
import {
  consumptionByBrand,
  consumptionByColor,
  consumptionByPrinter,
  consumptionByOutcome,
  totalConsumption,
} from '../../src/materials/reports';
import type { ProvenanceBreakdown } from '../../src/materials/reports';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-materials-reports-int.db';
const DB_URL = `file:${DB_PATH}`;

function uid(): string {
  return crypto.randomUUID();
}

async function seedUser(label: string): Promise<string> {
  const id = uid();
  await getServerDb(DB_URL).insert(schema.user).values({
    id,
    name: `Reports Test User ${label}`,
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

interface SeedMaterialOpts {
  ownerId: string;
  brand: string | null;
  colors: string[] | null;
  unit: 'g' | 'ml';
  initialAmount: number;
  /**
   * V2-005f-CF-1 T_g2: tests now pass a structured (printerId, slotIndex)
   * pair to load. `null` = leave un-loaded.
   *
   * NOTE: until V2-005f-CF-1 T_g4 lands, the report-layer
   * `loadedInPrinterRef` accessor is stubbed to always return null — so
   * `consumptionByPrinter` only ever sees the null bucket regardless of
   * whether materials are loaded. The two by-named-printer tests in this
   * file are skipped pending T_g4.
   */
  loadInto?: { printerId: string; slotIndex: number } | null;
  /** filament_spool / resin_bottle. Defaults to filament_spool when unit='g'. */
  kind?: 'filament_spool' | 'resin_bottle';
}

async function seedTestPrinter(ownerId: string, name: string): Promise<string> {
  const id = uid();
  await getServerDb(DB_URL).insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name,
    connectionConfig: {},
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedMaterial(opts: SeedMaterialOpts): Promise<{ id: string }> {
  const kind = opts.kind ?? (opts.unit === 'g' ? 'filament_spool' : 'resin_bottle');
  // createMaterial requires colors+colorPattern. For the "no colors" case we
  // pass a single placeholder, then null it out via direct UPDATE so the
  // by-color report tests the null-bucket path.
  const placeholderColors = opts.colors ?? ['#000000'];
  const r = await createMaterial(
    {
      ownerId: opts.ownerId,
      kind,
      brand: opts.brand ?? undefined,
      subtype: kind === 'filament_spool' ? 'PLA' : 'Standard',
      colors: placeholderColors,
      colorPattern: 'solid',
      initialAmount: opts.initialAmount,
      unit: opts.unit,
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedMaterial failed: ${r.reason}`);

  // Null-out colors when caller asked for null (createMaterial validates a
  // non-empty colors array, so we set null after the fact).
  if (opts.colors === null) {
    await getServerDb(DB_URL)
      .update(schema.materials)
      .set({ colors: null, colorPattern: null })
      .where(schemaEqId(r.material.id));
  }

  // Optional load-in-printer.
  if (opts.loadInto) {
    const lr = await loadInPrinter(
      {
        materialId: r.material.id,
        printerId: opts.loadInto.printerId,
        slotIndex: opts.loadInto.slotIndex,
        userId: opts.ownerId,
      },
      { dbUrl: DB_URL },
    );
    if (!lr.ok) throw new Error(`loadInPrinter failed: ${lr.reason}`);
  }

  return { id: r.material.id };
}

// drizzle's `eq` is needed; import lazily to keep this file's imports tight.
import { eq } from 'drizzle-orm';
function schemaEqId(id: string) {
  return eq(schema.materials.id, id);
}

// ---------------------------------------------------------------------------
// Seed data layout
// ---------------------------------------------------------------------------

const WINDOW_START = new Date('2026-04-01T00:00:00Z');
const WINDOW_END = new Date('2026-05-01T00:00:00Z');
const PRE_WINDOW = new Date('2026-03-15T00:00:00Z');
const POST_WINDOW = new Date('2026-05-15T00:00:00Z');
const EMPTY_WINDOW_START = new Date('2027-01-01T00:00:00Z');
const EMPTY_WINDOW_END = new Date('2027-02-01T00:00:00Z');

// Snapshot of seed mid-points produced once and reused across tests. The
// generator records the IDs of each seeded entity so individual tests can
// re-derive expected sums without re-querying the DB.
interface FixtureUser {
  ownerId: string;
  // Materials (focal/owner = "alpha"). Other owners get a similar-shaped set.
  materialIds: {
    bambuRedG: string;
    polymakerBlueG: string;
    elegooClearMl: string;
    unbrandedNoColorG: string; // brand=null, colors=null, no printer
  };
  /** Sum of consumed amounts by outcome (excluding recycled). */
  expected: {
    printOutputTotal: number;
    wasteTotal: number;
    consumedByBrand: Map<string | null, { total: number; provenance: ProvenanceBreakdown }>;
    consumedByPrimaryColor: Map<
      string | null,
      { total: number; provenance: ProvenanceBreakdown }
    >;
    consumedByPrinter: Map<
      string | null,
      { total: number; provenance: ProvenanceBreakdown }
    >;
    /** For owner alpha only: sum of recycle-event input weights from tracked sources. */
    recycledTrackedTotal: number;
    /** For owner alpha only: sum of recycle-event input weights from untracked scrap. */
    recycledUntrackedTotal: number;
  };
}

function emptyProv(): ProvenanceBreakdown {
  return {
    measured: 0,
    entered: 0,
    estimated: 0,
    derived: 0,
    computed: 0,
    system: 0,
  };
}

function bumpProv(
  p: ProvenanceBreakdown,
  klass: keyof ProvenanceBreakdown,
  amount: number,
): void {
  p[klass] += amount;
}

// In-window consumption recipe per user. Each entry: target slot, amount,
// provenance, outcome (print|waste).
type Recipe = Array<{
  slot: keyof FixtureUser['materialIds'];
  amount: number;
  provenance: 'measured' | 'entered' | 'estimated';
  outcome: 'print' | 'waste';
  /** Day offset from WINDOW_START for the synthetic occurredAt+ingestedAt. */
  day: number;
}>;

// Carefully chosen so each user's consumption distributes across multiple
// brands / colors / printers and has a mix of provenance classes.
const RECIPE: Recipe = [
  { slot: 'bambuRedG', amount: 30, provenance: 'measured', outcome: 'print', day: 1 },
  { slot: 'bambuRedG', amount: 5, provenance: 'estimated', outcome: 'waste', day: 2 },
  { slot: 'polymakerBlueG', amount: 50, provenance: 'measured', outcome: 'print', day: 3 },
  { slot: 'polymakerBlueG', amount: 10, provenance: 'entered', outcome: 'waste', day: 5 },
  { slot: 'elegooClearMl', amount: 80, provenance: 'measured', outcome: 'print', day: 7 },
  { slot: 'elegooClearMl', amount: 4, provenance: 'estimated', outcome: 'waste', day: 9 },
  { slot: 'unbrandedNoColorG', amount: 25, provenance: 'entered', outcome: 'print', day: 11 },
  { slot: 'unbrandedNoColorG', amount: 3, provenance: 'estimated', outcome: 'waste', day: 13 },
  { slot: 'bambuRedG', amount: 12, provenance: 'measured', outcome: 'print', day: 15 },
  { slot: 'polymakerBlueG', amount: 20, provenance: 'estimated', outcome: 'print', day: 20 },
];

async function seedUserAndMaterials(label: string): Promise<FixtureUser> {
  const ownerId = await seedUser(label);
  const printerAlpha = await seedTestPrinter(ownerId, `printer-alpha-${label}`);
  const printerBeta = await seedTestPrinter(ownerId, `printer-beta-${label}`);
  const printerGamma = await seedTestPrinter(ownerId, `printer-gamma-${label}`);
  const bambuRedG = await seedMaterial({
    ownerId,
    brand: 'Bambu Lab',
    colors: ['#E63946'],
    unit: 'g',
    initialAmount: 1000,
    loadInto: { printerId: printerAlpha, slotIndex: 0 },
  });
  const polymakerBlueG = await seedMaterial({
    ownerId,
    brand: 'Polymaker',
    colors: ['#1D4ED8'],
    unit: 'g',
    initialAmount: 1000,
    loadInto: { printerId: printerBeta, slotIndex: 0 },
  });
  const elegooClearMl = await seedMaterial({
    ownerId,
    brand: 'ELEGOO',
    colors: ['#EEEEEE'],
    unit: 'ml',
    initialAmount: 500,
    loadInto: { printerId: printerGamma, slotIndex: 0 },
  });
  const unbrandedNoColorG = await seedMaterial({
    ownerId,
    brand: null,
    colors: null,
    unit: 'g',
    initialAmount: 500,
    loadInto: null,
  });

  // Apply the recipe.
  let printOutputTotal = 0;
  let wasteTotal = 0;
  const consumedByBrand = new Map<
    string | null,
    { total: number; provenance: ProvenanceBreakdown }
  >();
  const consumedByPrimaryColor = new Map<
    string | null,
    { total: number; provenance: ProvenanceBreakdown }
  >();
  const consumedByPrinter = new Map<
    string | null,
    { total: number; provenance: ProvenanceBreakdown }
  >();

  function bucketRecord<TKey extends string | null>(
    map: Map<TKey, { total: number; provenance: ProvenanceBreakdown }>,
    key: TKey,
    amount: number,
    klass: keyof ProvenanceBreakdown,
  ): void {
    if (!map.has(key)) map.set(key, { total: 0, provenance: emptyProv() });
    const e = map.get(key)!;
    e.total += amount;
    bumpProv(e.provenance, klass, amount);
  }

  // V2-005f-CF-1 T_g4: report layer now LEFT JOINs to open `printer_loadouts`
  // rows, so each material's `loadedInPrinterRef` resolves to the printer it
  // was loaded into above. The unbranded material was deliberately not loaded
  // and therefore buckets under printer=null.
  const matMeta = {
    bambuRedG: {
      id: bambuRedG.id,
      brand: 'Bambu Lab' as string | null,
      primaryColor: '#E63946' as string | null,
      printer: printerAlpha as string | null,
    },
    polymakerBlueG: {
      id: polymakerBlueG.id,
      brand: 'Polymaker' as string | null,
      primaryColor: '#1D4ED8' as string | null,
      printer: printerBeta as string | null,
    },
    elegooClearMl: {
      id: elegooClearMl.id,
      brand: 'ELEGOO' as string | null,
      primaryColor: '#EEEEEE' as string | null,
      printer: printerGamma as string | null,
    },
    unbrandedNoColorG: {
      id: unbrandedNoColorG.id,
      brand: null as string | null,
      primaryColor: null as string | null,
      printer: null as string | null,
    },
  } as const;

  for (const step of RECIPE) {
    const meta = matMeta[step.slot];
    const occurredAt = new Date(WINDOW_START.getTime() + step.day * 24 * 3600 * 1000);
    // Ingested at the same moment for simplicity (T13's window uses ingestedAt).
    const r = await handleMaterialConsumed(
      {
        type: 'material.consumed',
        materialId: meta.id,
        weightConsumed: step.amount,
        provenanceClass: step.provenance,
        attributedTo:
          step.outcome === 'print'
            ? { kind: 'print', jobId: `job-${step.day}` }
            : { kind: 'waste', note: 'purge / failed' },
        occurredAt,
        source: 'forge:dispatch',
      },
      { dbUrl: DB_URL, now: occurredAt },
    );
    if (!r.ok) throw new Error(`consume failed: ${r.reason}`);

    if (step.outcome === 'print') printOutputTotal += step.amount;
    else wasteTotal += step.amount;

    bucketRecord(consumedByBrand, meta.brand, step.amount, step.provenance);
    bucketRecord(consumedByPrimaryColor, meta.primaryColor, step.amount, step.provenance);
    bucketRecord(consumedByPrinter, meta.printer, step.amount, step.provenance);
  }

  // Out-of-window (pre + post) noise events on the same user — must not be
  // counted by ANY report. Use distinct amounts (still small enough to leave
  // headroom for the recycle inputs further on) so test diagnostics can spot
  // leakage easily.
  await handleMaterialConsumed(
    {
      type: 'material.consumed',
      materialId: matMeta.elegooClearMl.id,
      weightConsumed: 99, // distinct, but doesn't exhaust the bottle
      provenanceClass: 'measured',
      attributedTo: { kind: 'print', jobId: 'pre-noise' },
      occurredAt: PRE_WINDOW,
      source: 'forge:dispatch',
    },
    { dbUrl: DB_URL, now: PRE_WINDOW },
  );
  await handleMaterialConsumed(
    {
      type: 'material.consumed',
      materialId: matMeta.unbrandedNoColorG.id,
      weightConsumed: 77,
      provenanceClass: 'measured',
      attributedTo: { kind: 'print', jobId: 'post-noise' },
      occurredAt: POST_WINDOW,
      source: 'forge:dispatch',
    },
    { dbUrl: DB_URL, now: POST_WINDOW },
  );

  return {
    ownerId,
    materialIds: {
      bambuRedG: matMeta.bambuRedG.id,
      polymakerBlueG: matMeta.polymakerBlueG.id,
      elegooClearMl: matMeta.elegooClearMl.id,
      unbrandedNoColorG: matMeta.unbrandedNoColorG.id,
    },
    expected: {
      printOutputTotal,
      wasteTotal,
      consumedByBrand,
      consumedByPrimaryColor,
      consumedByPrinter,
      recycledTrackedTotal: 0,
      recycledUntrackedTotal: 0,
    },
  };
}

// Module-scoped fixtures so individual tests don't have to re-seed.
let alpha: FixtureUser;
let bravo: FixtureUser;
let charlie: FixtureUser;
let recycledTrackedTotalAlpha = 0;
let recycledUntrackedTotalAlpha = 0;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);

  alpha = await seedUserAndMaterials('alpha');
  bravo = await seedUserAndMaterials('bravo');
  charlie = await seedUserAndMaterials('charlie');

  // Two recycle events for alpha — exercising both tracked and untracked
  // inputs. For predictable provenance bookkeeping we mark all recycle
  // inputs 'measured'.
  const r1 = await applyRecycleEvent(
    {
      ownerId: alpha.ownerId,
      actorUserId: alpha.ownerId,
      inputs: [
        {
          sourceMaterialId: alpha.materialIds.bambuRedG,
          weight: 40,
          provenanceClass: 'measured',
        },
        {
          sourceMaterialId: null, // untracked scrap — must NOT count
          weight: 1000, // distinctly large; a leak would be obvious
          provenanceClass: 'measured',
          note: 'untracked offcuts',
        },
      ],
      outputWeight: 1000, // ack required for this large output → set below
      acknowledgeWeightAnomaly: true,
      notes: 'recycle event 1',
    },
    { dbUrl: DB_URL, now: new Date(WINDOW_START.getTime() + 18 * 24 * 3600 * 1000) },
  );
  if (!r1.ok) throw new Error(`recycle r1 failed: ${r1.reason}`);
  recycledTrackedTotalAlpha += 40;
  recycledUntrackedTotalAlpha += 1000;

  const r2 = await applyRecycleEvent(
    {
      ownerId: alpha.ownerId,
      actorUserId: alpha.ownerId,
      inputs: [
        {
          sourceMaterialId: alpha.materialIds.polymakerBlueG,
          weight: 60,
          provenanceClass: 'measured',
        },
      ],
      outputWeight: 60,
      notes: 'recycle event 2',
    },
    { dbUrl: DB_URL, now: new Date(WINDOW_START.getTime() + 22 * 24 * 3600 * 1000) },
  );
  if (!r2.ok) throw new Error(`recycle r2 failed: ${r2.reason}`);
  recycledTrackedTotalAlpha += 60;

  // Out-of-window recycle noise — must NOT be counted by consumptionByOutcome.
  const r3 = await applyRecycleEvent(
    {
      ownerId: alpha.ownerId,
      actorUserId: alpha.ownerId,
      inputs: [
        {
          sourceMaterialId: alpha.materialIds.bambuRedG,
          weight: 5,
          provenanceClass: 'measured',
        },
      ],
      outputWeight: 5,
      notes: 'pre-window noise',
    },
    { dbUrl: DB_URL, now: PRE_WINDOW },
  );
  if (!r3.ok) throw new Error(`recycle r3 failed: ${r3.reason}`);

  alpha.expected.recycledTrackedTotal = recycledTrackedTotalAlpha;
  alpha.expected.recycledUntrackedTotal = recycledUntrackedTotalAlpha;
}, 60_000);

const WINDOW = { since: WINDOW_START, until: WINDOW_END } as const;
const EMPTY_WINDOW = {
  since: EMPTY_WINDOW_START,
  until: EMPTY_WINDOW_END,
} as const;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function provSum(p: ProvenanceBreakdown): number {
  return p.measured + p.entered + p.estimated + p.derived + p.computed + p.system;
}

// ---------------------------------------------------------------------------
// consumptionByBrand
// ---------------------------------------------------------------------------

describe('consumptionByBrand', () => {
  it('returns one row per distinct brand seen in the window', async () => {
    const rows = await consumptionByBrand(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const brands = rows.map((r) => r.key.brand);
    expect(brands).toContain('Bambu Lab');
    expect(brands).toContain('Polymaker');
    expect(brands).toContain('ELEGOO');
    expect(brands).toContain(null);
    expect(rows).toHaveLength(4);
  });

  it('provenance distribution sums to totalAmount per row', async () => {
    const rows = await consumptionByBrand(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    for (const r of rows) {
      expect(provSum(r.provenance)).toBeCloseTo(r.totalAmount, 6);
    }
  });

  it('totals match the recipe', async () => {
    const rows = await consumptionByBrand(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    for (const [brand, expected] of alpha.expected.consumedByBrand) {
      const row = rows.find((r) => r.key.brand === brand);
      expect(row, `brand=${brand}`).toBeDefined();
      expect(row!.totalAmount).toBeCloseTo(expected.total, 6);
      for (const k of Object.keys(expected.provenance) as Array<keyof ProvenanceBreakdown>) {
        expect(row!.provenance[k]).toBeCloseTo(expected.provenance[k], 6);
      }
    }
  });

  it('empty window returns empty array', async () => {
    const rows = await consumptionByBrand(
      { ownerId: alpha.ownerId, window: EMPTY_WINDOW },
      { dbUrl: DB_URL },
    );
    expect(rows).toEqual([]);
  });

  it('cross-owner data is not included', async () => {
    const rowsBravo = await consumptionByBrand(
      { ownerId: bravo.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const totalBravo = rowsBravo.reduce((a, r) => a + r.totalAmount, 0);
    const totalAlpha = alpha.expected.printOutputTotal + alpha.expected.wasteTotal;
    // Each user has the SAME recipe so totals are equal — but the IDs are
    // distinct. Re-run for charlie to demonstrate independent scoping.
    const rowsCharlie = await consumptionByBrand(
      { ownerId: charlie.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    expect(totalBravo).toBeCloseTo(totalAlpha, 6);
    expect(rowsCharlie.reduce((a, r) => a + r.totalAmount, 0)).toBeCloseTo(totalAlpha, 6);
    // Sanity: bravo and charlie have SAME totals as alpha (same recipe) — that's
    // expected. The owner-scoping is verified by rerunning with a tighter
    // assertion: a non-existent owner returns empty.
    const rowsGhost = await consumptionByBrand(
      { ownerId: 'nonexistent-user-id', window: WINDOW },
      { dbUrl: DB_URL },
    );
    expect(rowsGhost).toEqual([]);
  });

  it('sort order: alphabetical with null brand last', async () => {
    const rows = await consumptionByBrand(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const brands = rows.map((r) => r.key.brand);
    expect(brands[brands.length - 1]).toBeNull();
    const named = brands.slice(0, -1) as string[];
    const sortedNamed = [...named].sort((a, b) => a.localeCompare(b));
    expect(named).toEqual(sortedNamed);
  });
});

// ---------------------------------------------------------------------------
// consumptionByColor
// ---------------------------------------------------------------------------

describe('consumptionByColor', () => {
  it('uses colors[0] as primary color (uppercase)', async () => {
    const rows = await consumptionByColor(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const primaries = rows.map((r) => r.key.primaryColor);
    expect(primaries).toContain('#E63946');
    expect(primaries).toContain('#1D4ED8');
    expect(primaries).toContain('#EEEEEE');
  });

  it('materials with colors=null bucket under primaryColor=null', async () => {
    const rows = await consumptionByColor(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const nullRow = rows.find((r) => r.key.primaryColor === null);
    expect(nullRow).toBeDefined();
    const expected = alpha.expected.consumedByPrimaryColor.get(null)!;
    expect(nullRow!.totalAmount).toBeCloseTo(expected.total, 6);
  });

  it('provenance distribution sums to totalAmount per row', async () => {
    const rows = await consumptionByColor(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    for (const r of rows) {
      expect(provSum(r.provenance)).toBeCloseTo(r.totalAmount, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// consumptionByPrinter
// ---------------------------------------------------------------------------

describe('consumptionByPrinter', () => {
  // V2-005f-CF-1 T_g4: report layer LEFT JOINs to open printer_loadouts.
  // Each material's loadedInPrinterRef resolves to the printer id it was
  // seeded against; named-printer rows now appear.
  it('returns one row per distinct loadedInPrinterRef seen', async () => {
    const rows = await consumptionByPrinter(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const printers = rows.map((r) => r.key.printerRef);
    // The three loaded materials map to three distinct printer ids; the
    // unbranded material is unloaded so its rows bucket under null.
    const expectedPrinterIds = [...alpha.expected.consumedByPrinter.keys()].filter(
      (k): k is string => k !== null,
    );
    expect(expectedPrinterIds).toHaveLength(3);
    for (const pid of expectedPrinterIds) {
      expect(printers).toContain(pid);
    }
    expect(printers).toContain(null);
  });

  it('materials with no printer attribution bucket as null', async () => {
    const rows = await consumptionByPrinter(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const nullRow = rows.find((r) => r.key.printerRef === null);
    expect(nullRow).toBeDefined();
    const expected = alpha.expected.consumedByPrinter.get(null)!;
    expect(nullRow!.totalAmount).toBeCloseTo(expected.total, 6);
  });

  it('provenance distribution sums to totalAmount per row', async () => {
    const rows = await consumptionByPrinter(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    for (const r of rows) {
      expect(provSum(r.provenance)).toBeCloseTo(r.totalAmount, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// consumptionByOutcome
// ---------------------------------------------------------------------------

describe('consumptionByOutcome', () => {
  it('returns three buckets in fixed order', async () => {
    const rows = await consumptionByOutcome(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    expect(rows.map((r) => r.key.outcome)).toEqual(['print-output', 'waste', 'recycled']);
  });

  it('print-output sum = consumed events with attributedTo.kind=print', async () => {
    const rows = await consumptionByOutcome(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const po = rows.find((r) => r.key.outcome === 'print-output')!;
    expect(po.totalAmount).toBeCloseTo(alpha.expected.printOutputTotal, 6);
    expect(provSum(po.provenance)).toBeCloseTo(po.totalAmount, 6);
  });

  it('waste sum = consumed events with payload.subtype=waste', async () => {
    const rows = await consumptionByOutcome(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const w = rows.find((r) => r.key.outcome === 'waste')!;
    expect(w.totalAmount).toBeCloseTo(alpha.expected.wasteTotal, 6);
    expect(provSum(w.provenance)).toBeCloseTo(w.totalAmount, 6);
  });

  it('recycled sum = recycle inputs with non-null sourceMaterialId only', async () => {
    const rows = await consumptionByOutcome(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const rec = rows.find((r) => r.key.outcome === 'recycled')!;
    // Only tracked inputs should count. Untracked scrap (1000g) MUST be excluded.
    expect(rec.totalAmount).toBeCloseTo(alpha.expected.recycledTrackedTotal, 6);
    expect(rec.totalAmount).not.toBeCloseTo(
      alpha.expected.recycledTrackedTotal + alpha.expected.recycledUntrackedTotal,
      0,
    );
  });

  it('untracked scrap (sourceMaterialId=null) NOT counted in recycled', async () => {
    // Same assertion as above, made explicit for the test plan checklist.
    const rows = await consumptionByOutcome(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const rec = rows.find((r) => r.key.outcome === 'recycled')!;
    expect(rec.totalAmount).toBeLessThan(alpha.expected.recycledUntrackedTotal);
  });

  it('cross-owner recycle events are not included', async () => {
    const rows = await consumptionByOutcome(
      { ownerId: bravo.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const rec = rows.find((r) => r.key.outcome === 'recycled')!;
    expect(rec.totalAmount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// totalConsumption
// ---------------------------------------------------------------------------

describe('totalConsumption', () => {
  it('returns single row with key=null', async () => {
    const row = await totalConsumption(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    expect(row.key).toBeNull();
  });

  it('sum equals print-output + waste from by-outcome (recycled is NOT included)', async () => {
    const total = await totalConsumption(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const expected =
      alpha.expected.printOutputTotal + alpha.expected.wasteTotal;
    expect(total.totalAmount).toBeCloseTo(expected, 6);
    expect(provSum(total.provenance)).toBeCloseTo(total.totalAmount, 6);

    // Cross-check against by-outcome: total = print-output + waste exactly,
    // recycled is reported separately.
    const outcomeRows = await consumptionByOutcome(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    const po = outcomeRows.find((r) => r.key.outcome === 'print-output')!;
    const w = outcomeRows.find((r) => r.key.outcome === 'waste')!;
    expect(total.totalAmount).toBeCloseTo(po.totalAmount + w.totalAmount, 6);
  });

  it('unit is mixed when bucket spans both g and ml', async () => {
    // alpha consumed both filament (g) and resin (ml) — total bucket should
    // report 'mixed'.
    const total = await totalConsumption(
      { ownerId: alpha.ownerId, window: WINDOW },
      { dbUrl: DB_URL },
    );
    expect(total.unit).toBe('mixed');
  });

  it('empty window returns zeroed row', async () => {
    const total = await totalConsumption(
      { ownerId: alpha.ownerId, window: EMPTY_WINDOW },
      { dbUrl: DB_URL },
    );
    expect(total.totalAmount).toBe(0);
    expect(total.eventCount).toBe(0);
    expect(provSum(total.provenance)).toBe(0);
  });
});
