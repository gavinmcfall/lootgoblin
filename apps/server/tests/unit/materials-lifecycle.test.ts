/**
 * Unit tests for Material lifecycle — V2-007a-T4.
 *
 * Real-DB-on-tmpfile pattern (mirrors persistLedgerEvent test). Covers:
 *   - createMaterial: happy paths across kinds/colors + validation rejections
 *     + atomic rollback on ledger failure.
 *   - retireMaterial: happy path + already-retired, loaded-no-ack,
 *     active-dispatch stub.
 *   - loadInPrinter: happy path + filament slot conflict + retired guard +
 *     resin-bottle non-conflict.
 *   - unloadFromPrinter: happy path + not-loaded.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  createMaterial,
  retireMaterial,
  loadInPrinter,
  unloadFromPrinter,
} from '../../src/materials/lifecycle';
import {
  createFilamentProduct,
  createResinProduct,
} from '../../src/materials/catalog';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-materials-lifecycle-unit.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Materials Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/**
 * V2-005f-CF-1 T_g2: load/unload now FK against `printers`. Tests that
 * exercise loadInPrinter need a real printer row — seed a minimal one.
 */
async function seedTestPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name: `Test printer ${id.slice(0, 8)}`,
    connectionConfig: {},
    active: true,
    createdAt: new Date(),
  });
  return id;
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// createMaterial — happy paths
// ---------------------------------------------------------------------------

describe('createMaterial — happy paths', () => {
  it('1. filament_spool with single solid color → row + ledger persisted', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        brand: 'Bambu Lab',
        subtype: 'PLA Basic',
        colors: ['#E63946'],
        colorPattern: 'solid',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.kind).toBe('filament_spool');
    expect(result.material.colors).toEqual(['#E63946']);
    expect(result.material.colorPattern).toBe('solid');
    expect(result.material.initialAmount).toBe(1000);
    expect(result.material.remainingAmount).toBe(1000);
    expect(result.material.active).toBe(true);
    // V2-005f-CF-1 T_g1 dropped `loaded_in_printer_ref`; load tracking now
    // lives in `printer_loadouts`.

    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.ledgerEventId));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('material.added');
    expect(events[0]!.subjectType).toBe('material');
    expect(events[0]!.subjectId).toBe(result.material.id);
    expect(events[0]!.provenanceClass).toBe('entered');
    const payload = JSON.parse(events[0]!.payload!);
    expect(payload.initialAmount).toBe(1000);
    expect(payload.unit).toBe('g');
    expect(payload.kind).toBe('filament_spool');
  });

  it('2. resin_bottle with unit=ml → row inserted', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'resin_bottle',
        brand: 'ELEGOO',
        subtype: 'Standard Resin',
        colors: ['#222244'],
        colorPattern: 'solid',
        initialAmount: 500,
        unit: 'ml',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.unit).toBe('ml');
    expect(result.material.kind).toBe('resin_bottle');
  });

  it('3. dual-tone color → 2-entry colors array', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#FFD700', '#FFFFFF'],
        colorPattern: 'dual-tone',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.colors).toEqual(['#FFD700', '#FFFFFF']);
    expect(result.material.colorPattern).toBe('dual-tone');
  });

  it('4. multi-section 4-color → all four stored', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'],
        colorPattern: 'multi-section',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.colors).toHaveLength(4);
    expect(result.material.colorPattern).toBe('multi-section');
  });
});

// ---------------------------------------------------------------------------
// createMaterial — validation
// ---------------------------------------------------------------------------

describe('createMaterial — validation rejections', () => {
  it('5. empty colors array → reject', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: [],
        colorPattern: 'solid',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('colors-empty');
  });

  it('6. 5-entry colors → reject', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#111111', '#222222', '#333333', '#444444', '#555555'],
        colorPattern: 'multi-section',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('colors-too-many');
  });

  it('7. colorPattern=solid but colors.length=2 → color-pattern-mismatch', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#FF0000', '#00FF00'],
        colorPattern: 'solid',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('color-pattern-mismatch');
  });

  it('8. colorPattern=multi-section but colors.length=1 → reject', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#FF0000'],
        colorPattern: 'multi-section',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('color-pattern-mismatch');
  });

  it('9. malformed hex colors → color-format', async () => {
    const ownerId = await seedUser();
    for (const bad of ['red', '#FF', '#GGGGGG', '#F60', '#FF6B35CC']) {
      const result = await createMaterial(
        {
          ownerId,
          kind: 'filament_spool',
          colors: [bad],
          colorPattern: 'solid',
          initialAmount: 1000,
          unit: 'g',
        },
        { dbUrl: DB_URL },
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('color-format');
    }
  });

  it('10. lowercase hex normalized to uppercase on insert', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#ff6b35'],
        colorPattern: 'solid',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.colors).toEqual(['#FF6B35']);
  });

  it('11. filament_spool with unit=ml → unit-kind-mismatch', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#FF0000'],
        colorPattern: 'solid',
        initialAmount: 1000,
        unit: 'ml',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unit-kind-mismatch');
  });

  it('12. initialAmount=0 → reject', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#FF0000'],
        colorPattern: 'solid',
        initialAmount: 0,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('initial-amount-invalid');
  });

  it('13. initialAmount<0 → reject', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#FF0000'],
        colorPattern: 'solid',
        initialAmount: -50,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('initial-amount-invalid');
  });

  it('14. remainingAmount auto-set to initialAmount on create', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#FF0000'],
        colorPattern: 'solid',
        initialAmount: 750,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.remainingAmount).toBe(750);
    expect(result.material.initialAmount).toBe(750);
  });

  it('15. atomic rollback: ledger insert failure → no Material row left', async () => {
    const ownerId = await seedUser();

    // Force the ledger insert to fail by intercepting getServerDb. We wrap
    // the real DB in a Proxy whose `.insert(...)` returns a builder that
    // throws if the target table is `ledger_events`, while passing through
    // all other table inserts (so the Material insert succeeds inside the
    // transaction — and is then rolled back when the ledger insert raises).
    const clientModule = await import('../../src/db/client');
    const realDb = clientModule.getServerDb(DB_URL);

    const wrappedDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) => {
            const builder = (target as unknown as { insert: (t: unknown) => unknown }).insert(table);
            if (table === schema.ledgerEvents) {
              return new Proxy(builder as object, {
                get(b, p, r) {
                  if (p === 'values') {
                    return () => ({
                      run: () => {
                        throw new Error('forced ledger insert failure');
                      },
                    });
                  }
                  return Reflect.get(b, p, r);
                },
              });
            }
            return builder;
          };
        }
        if (prop === 'transaction') {
          // Transaction must use OUR wrappedDb so the ledger insert path is
          // what fires. better-sqlite3 transaction passes a tx scope; we
          // wrap it the same way.
          return <T>(fn: (tx: unknown) => T): T => {
            return (target as unknown as { transaction: <U>(f: (t: unknown) => U) => U }).transaction((tx) => {
              const wrappedTx = new Proxy(tx as object, {
                get(t, p, r) {
                  if (p === 'insert') {
                    return (table: unknown) => {
                      const builder = (t as unknown as { insert: (tbl: unknown) => unknown }).insert(table);
                      if (table === schema.ledgerEvents) {
                        return new Proxy(builder as object, {
                          get(b, q, rr) {
                            if (q === 'values') {
                              return () => ({
                                run: () => {
                                  throw new Error('forced ledger insert failure');
                                },
                              });
                            }
                            return Reflect.get(b, q, rr);
                          },
                        });
                      }
                      return builder;
                    };
                  }
                  return Reflect.get(t, p, r);
                },
              });
              return fn(wrappedTx);
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    vi.spyOn(clientModule, 'getServerDb').mockReturnValue(wrappedDb as unknown as ReturnType<typeof clientModule.getServerDb>);

    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        colors: ['#ABCDEF'],
        colorPattern: 'solid',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('persist-failed');

    // Restore so the verification query below uses the real DB.
    vi.restoreAllMocks();

    // Verify NO orphan Material row was left behind. The transaction must
    // have rolled back the Material insert when the ledger insert threw.
    const allForOwner = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.ownerId, ownerId));
    const orphans = allForOwner.filter(
      (m) => Array.isArray(m.colors) && m.colors[0] === '#ABCDEF',
    );
    expect(orphans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// retireMaterial
// ---------------------------------------------------------------------------

async function createTestMaterial(
  ownerId: string,
  overrides: Partial<Parameters<typeof createMaterial>[0]> = {},
): Promise<typeof schema.materials.$inferSelect> {
  const result = await createMaterial(
    {
      ownerId,
      kind: 'filament_spool',
      colors: ['#123456'],
      colorPattern: 'solid',
      initialAmount: 1000,
      unit: 'g',
      ...overrides,
    },
    { dbUrl: DB_URL },
  );
  if (!result.ok) throw new Error(`createTestMaterial failed: ${result.reason}`);
  return result.material;
}

describe('retireMaterial', () => {
  it('16. happy path → active=false, retirementReason set, ledger event recorded', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);

    // Manually consume some material so we can assert remainingAtRetirement.
    await db()
      .update(schema.materials)
      .set({ remainingAmount: 250 })
      .where(eq(schema.materials.id, m.id));

    const result = await retireMaterial(
      {
        materialId: m.id,
        actorUserId: ownerId,
        retirementReason: 'tangled',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, m.id));
    expect(rows[0]!.active).toBe(false);
    expect(rows[0]!.retirementReason).toBe('tangled');
    expect(rows[0]!.retiredAt).toBeInstanceOf(Date);
    expect(rows[0]!.remainingAmount).toBe(250); // preserved

    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.ledgerEventId));
    expect(events[0]!.kind).toBe('material.retired');
    const payload = JSON.parse(events[0]!.payload!);
    expect(payload.retirementReason).toBe('tangled');
    expect(payload.remainingAtRetirement).toBe(250);
    expect(payload.kind).toBe('filament_spool');
  });

  it('17. already-retired → reject', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    const first = await retireMaterial(
      { materialId: m.id, actorUserId: ownerId, retirementReason: 'first' },
      { dbUrl: DB_URL },
    );
    expect(first.ok).toBe(true);

    const second = await retireMaterial(
      { materialId: m.id, actorUserId: ownerId, retirementReason: 'second' },
      { dbUrl: DB_URL },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already-retired');
  });

  it('18. loaded-in-printer + no acknowledge → loaded-in-printer-no-ack', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    const printerId = await seedTestPrinter(ownerId);
    const lr = await loadInPrinter(
      { materialId: m.id, printerId, slotIndex: 2, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(lr.ok).toBe(true);

    const result = await retireMaterial(
      { materialId: m.id, actorUserId: ownerId, retirementReason: 'broken' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('loaded-in-printer-no-ack');
  });

  it('19. loaded + acknowledgeLoaded=true → retires, leaves open loadout row as-is', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    const printerId = await seedTestPrinter(ownerId);
    const lr = await loadInPrinter(
      { materialId: m.id, printerId, slotIndex: 2, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(lr.ok).toBe(true);

    const result = await retireMaterial(
      {
        materialId: m.id,
        actorUserId: ownerId,
        retirementReason: 'broken',
        acknowledgeLoaded: true,
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);

    const rows = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, m.id));
    expect(rows[0]!.active).toBe(false);
    // V2-005f-CF-1 T_g2 leaves the `printer_loadouts` row open — physical
    // unload remains the operator's responsibility (consistent with the
    // V2-007a-T4 semantics against the legacy free-text column).
    const open = await db()
      .select()
      .from(schema.printerLoadouts)
      .where(eq(schema.printerLoadouts.materialId, m.id));
    expect(open).toHaveLength(1);
    expect(open[0]!.unloadedAt).toBeNull();
  });

  it('20. active dispatch via stub → reject with active-dispatch', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);

    const result = await retireMaterial(
      { materialId: m.id, actorUserId: ownerId, retirementReason: 'no longer needed' },
      {
        dbUrl: DB_URL,
        checkActiveDispatches: async () => ({ exists: true, jobIds: ['j1'] }),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('active-dispatch');
    expect(result.details).toContain('j1');
  });
});

// ---------------------------------------------------------------------------
// loadInPrinter
// ---------------------------------------------------------------------------

describe('loadInPrinter', () => {
  it('21. happy path: filament_spool with no conflict → printer_loadouts row + ledger event', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    const printerId = await seedTestPrinter(ownerId);

    const result = await loadInPrinter(
      { materialId: m.id, printerId, slotIndex: 3, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Open loadout row exists with the right (printer, slot).
    const loadouts = await db()
      .select()
      .from(schema.printerLoadouts)
      .where(eq(schema.printerLoadouts.materialId, m.id));
    expect(loadouts).toHaveLength(1);
    expect(loadouts[0]!.printerId).toBe(printerId);
    expect(loadouts[0]!.slotIndex).toBe(3);
    expect(loadouts[0]!.unloadedAt).toBeNull();

    // Ledger event emitted with the structured T_g2 payload.
    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.subjectId, m.id));
    const loadEvent = events.find((e) => e.kind === 'material.loaded');
    expect(loadEvent).toBeDefined();
    const payload = JSON.parse(loadEvent!.payload!);
    expect(payload.printerId).toBe(printerId);
    expect(payload.slotIndex).toBe(3);
    expect(payload.loadoutId).toBe(result.loadoutId);
  });

  it('22. another material in the same (printer, slot) → atomic swap + swappedOutMaterialId', async () => {
    const ownerId = await seedUser();
    const printerId = await seedTestPrinter(ownerId);

    const first = await createTestMaterial(ownerId);
    const second = await createTestMaterial(ownerId, { colors: ['#ABCDEF'] });

    const r1 = await loadInPrinter(
      { materialId: first.id, printerId, slotIndex: 1, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);

    // Loading a different material into the same slot atomically swaps —
    // the incumbent is unloaded (reason='swap') and the new row is opened.
    const r2 = await loadInPrinter(
      { materialId: second.id, printerId, slotIndex: 1, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.swappedOutMaterialId).toBe(first.id);
  });

  it('23. material already loaded ELSEWHERE → material-already-loaded-elsewhere', async () => {
    const ownerId = await seedUser();
    const printerA = await seedTestPrinter(ownerId);
    const printerB = await seedTestPrinter(ownerId);
    const m = await createTestMaterial(ownerId);

    const r1 = await loadInPrinter(
      { materialId: m.id, printerId: printerA, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);

    // Trying to load the SAME material into a different (printer, slot) is
    // rejected — a material can only be in one place at a time.
    const r2 = await loadInPrinter(
      { materialId: m.id, printerId: printerB, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('material-already-loaded-elsewhere');
  });

  it('24. material already retired → material-retired', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    const printerId = await seedTestPrinter(ownerId);
    await retireMaterial(
      { materialId: m.id, actorUserId: ownerId, retirementReason: 'done' },
      { dbUrl: DB_URL },
    );

    const result = await loadInPrinter(
      { materialId: m.id, printerId, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('material-retired');
  });
});

// ---------------------------------------------------------------------------
// unloadFromPrinter
// ---------------------------------------------------------------------------

describe('unloadFromPrinter', () => {
  it('25. happy path: stamps unloaded_at on the open row + emits ledger event', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    const printerId = await seedTestPrinter(ownerId);
    const lr = await loadInPrinter(
      { materialId: m.id, printerId, slotIndex: 1, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(lr.ok).toBe(true);

    const result = await unloadFromPrinter(
      { materialId: m.id, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previousPrinterId).toBe(printerId);
    expect(result.previousSlotIndex).toBe(1);

    // Open row is now closed.
    const loadouts = await db()
      .select()
      .from(schema.printerLoadouts)
      .where(eq(schema.printerLoadouts.id, result.loadoutId));
    expect(loadouts[0]!.unloadedAt).toBeInstanceOf(Date);

    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.subjectId, m.id));
    const unloadEvent = events.find((e) => e.kind === 'material.unloaded');
    expect(unloadEvent).toBeDefined();
    const payload = JSON.parse(unloadEvent!.payload!);
    expect(payload.printerId).toBe(printerId);
    expect(payload.slotIndex).toBe(1);
    expect(payload.reason).toBe('manual');
  });

  it('26. not currently loaded → material-not-loaded', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    const result = await unloadFromPrinter(
      { materialId: m.id, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('material-not-loaded');
  });
});

// ---------------------------------------------------------------------------
// createMaterial — catalog product linkage (V2-007b T_B3)
// ---------------------------------------------------------------------------

async function seedSystemFilament(opts: {
  brand?: string;
  subtype?: string;
  colors?: string[];
  colorPattern?: 'solid' | 'dual-tone' | 'gradient' | 'multi-section';
  colorName?: string | null;
  density?: number | null;
  adminId: string;
} = { adminId: '' }): Promise<string> {
  const r = await createFilamentProduct(
    {
      brand: opts.brand ?? 'Polymaker',
      subtype: opts.subtype ?? 'PLA',
      colors: opts.colors ?? ['#123ABC'],
      colorPattern: opts.colorPattern ?? 'solid',
      colorName: opts.colorName ?? 'Sky Blue',
      density: opts.density ?? 1.24,
      source: 'system:spoolmandb',
      ownerId: null,
      actorUserId: opts.adminId,
      actorRole: 'admin',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedSystemFilament failed: ${r.reason}`);
  return r.productId;
}

async function seedUserCustomFilament(ownerId: string): Promise<string> {
  const r = await createFilamentProduct(
    {
      brand: 'Homebrew Co',
      subtype: 'PETG',
      colors: ['#FF8800'],
      colorPattern: 'solid',
      colorName: 'Orange Workshop Mix',
      density: 1.27,
      source: 'user',
      ownerId,
      actorUserId: ownerId,
      actorRole: 'user',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedUserCustomFilament failed: ${r.reason}`);
  return r.productId;
}

async function seedSystemResin(adminId: string): Promise<string> {
  const r = await createResinProduct(
    {
      brand: 'ELEGOO',
      subtype: 'standard',
      colors: ['#222222'],
      colorName: 'Skull Grey',
      densityGMl: 1.1,
      source: 'system:spoolmandb',
      ownerId: null,
      actorUserId: adminId,
      actorRole: 'admin',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedSystemResin failed: ${r.reason}`);
  return r.productId;
}

describe('createMaterial — catalog linkage (T_B3)', () => {
  it('27. filament_spool linked to system filament_products → denormalized fields', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const productId = await seedSystemFilament({
      brand: 'Bambu Lab',
      subtype: 'PLA',
      colors: ['#E6F0FF'],
      colorPattern: 'solid',
      colorName: 'Galaxy Blue',
      density: 1.24,
      adminId,
    });

    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        productId,
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.productId).toBe(productId);
    expect(result.material.brand).toBe('Bambu Lab');
    expect(result.material.subtype).toBe('PLA');
    expect(result.material.colors).toEqual(['#E6F0FF']);
    expect(result.material.colorPattern).toBe('solid');
    expect(result.material.colorName).toBe('Galaxy Blue');
    expect(result.material.density).toBe(1.24);
  });

  it('28. linked to caller’s own custom filament product → denormalized fields', async () => {
    const ownerId = await seedUser();
    const productId = await seedUserCustomFilament(ownerId);

    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        productId,
        initialAmount: 750,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.productId).toBe(productId);
    expect(result.material.brand).toBe('Homebrew Co');
    expect(result.material.subtype).toBe('PETG');
    expect(result.material.colors).toEqual(['#FF8800']);
  });

  it('29. caller-supplied colors override the catalog product (multi-section section pick)', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    // Catalog entry is a 4-color multi-section batch.
    const productId = await seedSystemFilament({
      brand: 'GradientCo',
      subtype: 'PLA-Silk',
      colors: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'],
      colorPattern: 'multi-section',
      colorName: '4-Tone Carnival',
      density: 1.24,
      adminId,
    });

    // User is spooling JUST the red section.
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        productId,
        colors: ['#FF0000'],
        colorPattern: 'solid',
        initialAmount: 250,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.productId).toBe(productId);
    expect(result.material.colors).toEqual(['#FF0000']);
    expect(result.material.colorPattern).toBe('solid');
    // brand/subtype STILL come from the catalog product.
    expect(result.material.brand).toBe('GradientCo');
    expect(result.material.subtype).toBe('PLA-Silk');
  });

  it('30. resin_bottle linked to a resin_products entry', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const productId = await seedSystemResin(adminId);

    const result = await createMaterial(
      {
        ownerId,
        kind: 'resin_bottle',
        productId,
        initialAmount: 500,
        unit: 'ml',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.productId).toBe(productId);
    expect(result.material.brand).toBe('ELEGOO');
    expect(result.material.subtype).toBe('standard');
    expect(result.material.colors).toEqual(['#222222']);
    expect(result.material.density).toBe(1.1);
  });

  it('31. productId points to filament but kind=resin_bottle → product-kind-mismatch', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const productId = await seedSystemFilament({ adminId });

    const result = await createMaterial(
      {
        ownerId,
        kind: 'resin_bottle',
        productId,
        initialAmount: 500,
        unit: 'ml',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('product-kind-mismatch');
  });

  it('32. productId points to resin but kind=filament_spool → product-kind-mismatch', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const productId = await seedSystemResin(adminId);

    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        productId,
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('product-kind-mismatch');
  });

  it('33. productId set + kind=mix_batch → product-not-allowed-for-kind', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const productId = await seedSystemFilament({ adminId });

    const result = await createMaterial(
      {
        ownerId,
        kind: 'mix_batch',
        productId,
        colors: ['#AAAAAA'],
        colorPattern: 'solid',
        initialAmount: 250,
        unit: 'ml',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('product-not-allowed-for-kind');
  });

  it('34. productId does not exist → product-not-found', async () => {
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        productId: crypto.randomUUID(),
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('product-not-found');
  });

  it('35. productId points to another user’s custom entry → product-not-found (no leak)', async () => {
    const otherUserId = await seedUser();
    const ownerId = await seedUser();
    const productId = await seedUserCustomFilament(otherUserId);

    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        productId,
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Same reason as truly-missing — no information leak.
    expect(result.reason).toBe('product-not-found');
  });

  it('36. recycled_spool with productId set → product-not-allowed-for-kind', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const productId = await seedSystemFilament({ adminId });

    const result = await createMaterial(
      {
        ownerId,
        kind: 'recycled_spool',
        productId,
        colors: ['#888888'],
        colorPattern: 'solid',
        initialAmount: 800,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('product-not-allowed-for-kind');
  });

  it('37. productId NULL with full inline fields → identical to T4 manual-entry behavior', async () => {
    // Backward-compat sanity: this is the manual-entry path.
    const ownerId = await seedUser();
    const result = await createMaterial(
      {
        ownerId,
        kind: 'filament_spool',
        productId: null,
        brand: 'Manual Brand',
        subtype: 'Manual PLA',
        colors: ['#ABCDEF'],
        colorPattern: 'solid',
        initialAmount: 1000,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.productId).toBeNull();
    expect(result.material.brand).toBe('Manual Brand');
  });
});
