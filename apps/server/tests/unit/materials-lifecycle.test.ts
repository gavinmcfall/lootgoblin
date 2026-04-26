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
    expect(result.material.loadedInPrinterRef).toBeNull();

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
    await db()
      .update(schema.materials)
      .set({ loadedInPrinterRef: 'bambu-x1c-#1:tray-2' })
      .where(eq(schema.materials.id, m.id));

    const result = await retireMaterial(
      { materialId: m.id, actorUserId: ownerId, retirementReason: 'broken' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('loaded-in-printer-no-ack');
  });

  it('19. loaded + acknowledgeLoaded=true → retires, leaves loadedInPrinterRef as-is', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    await db()
      .update(schema.materials)
      .set({ loadedInPrinterRef: 'bambu-x1c-#1:tray-2' })
      .where(eq(schema.materials.id, m.id));

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
    // V2-005 will handle physical unload; T4 leaves the ref untouched.
    expect(rows[0]!.loadedInPrinterRef).toBe('bambu-x1c-#1:tray-2');
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
  it('21. happy path: filament_spool with no conflict → loadedInPrinterRef set + ledger event', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);

    const result = await loadInPrinter(
      { materialId: m.id, actorUserId: ownerId, printerRef: 'bambu-x1c-#1:tray-3' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, m.id));
    expect(rows[0]!.loadedInPrinterRef).toBe('bambu-x1c-#1:tray-3');

    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.ledgerEventId));
    expect(events[0]!.kind).toBe('material.loaded');
    const payload = JSON.parse(events[0]!.payload!);
    expect(payload.printerRef).toBe('bambu-x1c-#1:tray-3');
  });

  it('22. another filament_spool already loaded at same printerRef → printer-slot-occupied', async () => {
    const ownerId = await seedUser();
    const slot = 'bambu-x1c-conflict:tray-1';

    const first = await createTestMaterial(ownerId);
    const second = await createTestMaterial(ownerId, { colors: ['#ABCDEF'] });

    const r1 = await loadInPrinter(
      { materialId: first.id, actorUserId: ownerId, printerRef: slot },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);

    const r2 = await loadInPrinter(
      { materialId: second.id, actorUserId: ownerId, printerRef: slot },
      { dbUrl: DB_URL },
    );
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('printer-slot-occupied');
  });

  it('23. resin_bottle CAN load at same printerRef as a filament', async () => {
    const ownerId = await seedUser();
    const slot = 'shared-rig:slot-A';

    const filament = await createTestMaterial(ownerId);
    const resin = await createTestMaterial(ownerId, {
      kind: 'resin_bottle',
      unit: 'ml',
      initialAmount: 500,
      colors: ['#444444'],
    });

    const r1 = await loadInPrinter(
      { materialId: filament.id, actorUserId: ownerId, printerRef: slot },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);

    const r2 = await loadInPrinter(
      { materialId: resin.id, actorUserId: ownerId, printerRef: slot },
      { dbUrl: DB_URL },
    );
    expect(r2.ok).toBe(true);
  });

  it('24. material already retired → material-retired', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    await retireMaterial(
      { materialId: m.id, actorUserId: ownerId, retirementReason: 'done' },
      { dbUrl: DB_URL },
    );

    const result = await loadInPrinter(
      { materialId: m.id, actorUserId: ownerId, printerRef: 'any-printer:slot-1' },
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
  it('25. happy path: clears loadedInPrinterRef + ledger event captures previous', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    const slot = 'bambu-x1c-unload-test:tray-1';
    await loadInPrinter(
      { materialId: m.id, actorUserId: ownerId, printerRef: slot },
      { dbUrl: DB_URL },
    );

    const result = await unloadFromPrinter(
      { materialId: m.id, actorUserId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previousPrinterRef).toBe(slot);

    const rows = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, m.id));
    expect(rows[0]!.loadedInPrinterRef).toBeNull();

    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.ledgerEventId));
    expect(events[0]!.kind).toBe('material.unloaded');
    const payload = JSON.parse(events[0]!.payload!);
    expect(payload.printerRef).toBe(slot);
  });

  it('26. not currently loaded → not-loaded', async () => {
    const ownerId = await seedUser();
    const m = await createTestMaterial(ownerId);
    const result = await unloadFromPrinter(
      { materialId: m.id, actorUserId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-loaded');
  });
});
