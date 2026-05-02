/**
 * V2-005f-CF-1 T_g2 — unit tests for forge/loadouts/lifecycle.ts.
 *
 * Real-DB-on-tmpfile pattern (mirrors materials-lifecycle.test.ts).
 *
 * Coverage:
 *   1.  loads material into empty slot — emits material.loaded
 *   2.  atomic swap into occupied slot — emits 2 events + swappedOutMaterialId
 *   3.  idempotent re-load (same material, same slot) — no new row
 *   4.  reject when material already loaded in different slot (same printer)
 *   5.  reject when material already loaded on different printer
 *   6.  unload happy path — emits material.unloaded with reason='manual'
 *   7.  unloading not-loaded material returns material-not-loaded
 *   8.  non-existent material → material-not-found (load)
 *   9.  non-existent printer → printer-not-found (load)
 *   10. negative slot_index → invalid-slot
 *   11. retired material → material-retired
 *   12. atomicity: ledger insert fails mid-tx → loadout row NOT inserted
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { loadInPrinter, unloadFromPrinter } from '../../src/forge/loadouts/lifecycle';
import { createMaterial } from '../../src/materials/lifecycle';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-loadout-lifecycle-unit.db';
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
    name: 'Loadout Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name: `Test Printer ${id.slice(0, 8)}`,
    connectionConfig: { url: 'http://example.test:7125' },
    active: true,
  });
  return id;
}

async function seedMaterial(ownerId: string, opts: { active?: boolean } = {}): Promise<string> {
  const r = await createMaterial(
    {
      ownerId,
      kind: 'filament_spool',
      colors: ['#AA1199'],
      colorPattern: 'solid',
      initialAmount: 1000,
      unit: 'g',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedMaterial failed: ${r.reason}`);
  if (opts.active === false) {
    await db()
      .update(schema.materials)
      .set({ active: false, retiredAt: new Date(), retirementReason: 'test' })
      .where(eq(schema.materials.id, r.material.id));
  }
  return r.material.id;
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
// 1–5: loadInPrinter
// ---------------------------------------------------------------------------

describe('loadInPrinter', () => {
  it('1. loads material into empty slot, emits material.loaded ledger event', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const materialId = await seedMaterial(ownerId);

    const result = await loadInPrinter(
      { materialId, printerId, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.swappedOutMaterialId).toBeUndefined();

    const rows = await db()
      .select()
      .from(schema.printerLoadouts)
      .where(eq(schema.printerLoadouts.id, result.loadoutId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.materialId).toBe(materialId);
    expect(rows[0]!.printerId).toBe(printerId);
    expect(rows[0]!.slotIndex).toBe(0);
    expect(rows[0]!.unloadedAt).toBeNull();
    expect(rows[0]!.loadedByUserId).toBe(ownerId);

    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.loaded'),
          eq(schema.ledgerEvents.subjectId, materialId),
        ),
      );
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload!);
    expect(payload.printerId).toBe(printerId);
    expect(payload.slotIndex).toBe(0);
    expect(payload.loadoutId).toBe(result.loadoutId);
    expect(payload.swappedOutMaterialId).toBeUndefined();
  });

  it('2. atomic swap into occupied slot — unloads incumbent + loads new + 2 ledger events', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const matA = await seedMaterial(ownerId);
    const matB = await seedMaterial(ownerId);

    const r1 = await loadInPrinter(
      { materialId: matA, printerId, slotIndex: 1, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = await loadInPrinter(
      { materialId: matB, printerId, slotIndex: 1, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.swappedOutMaterialId).toBe(matA);

    // Old row stamped, new row open.
    const oldRow = (await db()
      .select()
      .from(schema.printerLoadouts)
      .where(eq(schema.printerLoadouts.id, r1.loadoutId)))[0]!;
    expect(oldRow.unloadedAt).not.toBeNull();
    expect(oldRow.unloadedByUserId).toBe(ownerId);
    const newRow = (await db()
      .select()
      .from(schema.printerLoadouts)
      .where(eq(schema.printerLoadouts.id, r2.loadoutId)))[0]!;
    expect(newRow.unloadedAt).toBeNull();
    expect(newRow.materialId).toBe(matB);

    // 2 ledger events emitted in the swap tx (1 unload, 1 load with swappedOut).
    const unloadEvents = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.unloaded'),
          eq(schema.ledgerEvents.subjectId, matA),
        ),
      );
    expect(unloadEvents).toHaveLength(1);
    const unloadPayload = JSON.parse(unloadEvents[0]!.payload!);
    expect(unloadPayload.reason).toBe('swap');
    expect(unloadPayload.loadoutId).toBe(r1.loadoutId);

    const loadEvents = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.loaded'),
          eq(schema.ledgerEvents.subjectId, matB),
        ),
      );
    expect(loadEvents).toHaveLength(1);
    const loadPayload = JSON.parse(loadEvents[0]!.payload!);
    expect(loadPayload.swappedOutMaterialId).toBe(matA);
  });

  it('3. idempotent re-load (same material, same printer + slot) returns existing loadoutId', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const materialId = await seedMaterial(ownerId);

    const r1 = await loadInPrinter(
      { materialId, printerId, slotIndex: 2, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = await loadInPrinter(
      { materialId, printerId, slotIndex: 2, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.loadoutId).toBe(r1.loadoutId);

    // No second row.
    const allOpen = await db()
      .select()
      .from(schema.printerLoadouts)
      .where(
        and(
          eq(schema.printerLoadouts.materialId, materialId),
          isNull(schema.printerLoadouts.unloadedAt),
        ),
      );
    expect(allOpen).toHaveLength(1);

    // Idempotent re-load does NOT emit a duplicate material.loaded event.
    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.loaded'),
          eq(schema.ledgerEvents.subjectId, materialId),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('4. reject when material already loaded in different slot on same printer', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const materialId = await seedMaterial(ownerId);

    await loadInPrinter(
      { materialId, printerId, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );

    const result = await loadInPrinter(
      { materialId, printerId, slotIndex: 3, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('material-already-loaded-elsewhere');
    expect(result.details).toContain('slot 0');
  });

  it('5. reject when material already loaded on different printer', async () => {
    const ownerId = await seedUser();
    const printerA = await seedPrinter(ownerId);
    const printerB = await seedPrinter(ownerId);
    const materialId = await seedMaterial(ownerId);

    await loadInPrinter(
      { materialId, printerId: printerA, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );

    const result = await loadInPrinter(
      { materialId, printerId: printerB, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('material-already-loaded-elsewhere');
  });
});

// ---------------------------------------------------------------------------
// 6–7: unloadFromPrinter
// ---------------------------------------------------------------------------

describe('unloadFromPrinter', () => {
  it('6. unloads currently-loaded material, emits material.unloaded with reason=manual', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const materialId = await seedMaterial(ownerId);

    const loadResult = await loadInPrinter(
      { materialId, printerId, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const result = await unloadFromPrinter(
      { materialId, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loadoutId).toBe(loadResult.loadoutId);
    expect(result.previousPrinterId).toBe(printerId);
    expect(result.previousSlotIndex).toBe(0);

    const row = (await db()
      .select()
      .from(schema.printerLoadouts)
      .where(eq(schema.printerLoadouts.id, loadResult.loadoutId)))[0]!;
    expect(row.unloadedAt).not.toBeNull();
    expect(row.unloadedByUserId).toBe(ownerId);

    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(
        and(
          eq(schema.ledgerEvents.kind, 'material.unloaded'),
          eq(schema.ledgerEvents.subjectId, materialId),
        ),
      );
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload!);
    expect(payload.reason).toBe('manual');
    expect(payload.printerId).toBe(printerId);
    expect(payload.slotIndex).toBe(0);
  });

  it('7. unloading not-loaded material returns material-not-loaded', async () => {
    const ownerId = await seedUser();
    const materialId = await seedMaterial(ownerId);

    const result = await unloadFromPrinter(
      { materialId, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('material-not-loaded');
  });
});

// ---------------------------------------------------------------------------
// 8–11: validation
// ---------------------------------------------------------------------------

describe('loadInPrinter — validation', () => {
  it('8. non-existent material → material-not-found', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const result = await loadInPrinter(
      { materialId: crypto.randomUUID(), printerId, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('material-not-found');
  });

  it('9. non-existent printer → printer-not-found', async () => {
    const ownerId = await seedUser();
    const materialId = await seedMaterial(ownerId);
    const result = await loadInPrinter(
      { materialId, printerId: crypto.randomUUID(), slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('printer-not-found');
  });

  it('10. negative slot_index → invalid-slot', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const materialId = await seedMaterial(ownerId);
    const result = await loadInPrinter(
      { materialId, printerId, slotIndex: -1, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-slot');
  });

  it('11. retired material → material-retired', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const materialId = await seedMaterial(ownerId, { active: false });
    const result = await loadInPrinter(
      { materialId, printerId, slotIndex: 0, userId: ownerId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('material-retired');
  });
});

// ---------------------------------------------------------------------------
// 12: atomicity rollback
// ---------------------------------------------------------------------------

describe('loadInPrinter — atomicity', () => {
  it('12. ledger insert fails mid-tx → loadout row NOT persisted (transaction rolls back)', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const materialId = await seedMaterial(ownerId);

    // Wrap getServerDb so that inserts into ledgerEvents throw inside the tx.
    // The Material insert succeeds inside the same tx, then the ledger insert
    // raises and the entire tx is rolled back — no loadout row should remain.
    const clientModule = await import('../../src/db/client');
    const realDb = clientModule.getServerDb(DB_URL);

    const wrappedDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return <T>(fn: (tx: unknown) => T): T => {
            return (
              target as unknown as { transaction: <U>(f: (t: unknown) => U) => U }
            ).transaction((tx) => {
              const wrappedTx = new Proxy(tx as object, {
                get(t, p, r) {
                  if (p === 'insert') {
                    return (table: unknown) => {
                      const builder = (
                        t as unknown as { insert: (tbl: unknown) => unknown }
                      ).insert(table);
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

    vi.spyOn(clientModule, 'getServerDb').mockReturnValue(
      wrappedDb as unknown as ReturnType<typeof clientModule.getServerDb>,
    );

    await expect(
      loadInPrinter(
        { materialId, printerId, slotIndex: 5, userId: ownerId },
        { dbUrl: DB_URL },
      ),
    ).rejects.toThrow();

    // Restore so the verification query uses the real DB.
    vi.restoreAllMocks();

    const persisted = await db()
      .select()
      .from(schema.printerLoadouts)
      .where(
        and(
          eq(schema.printerLoadouts.printerId, printerId),
          eq(schema.printerLoadouts.slotIndex, 5),
        ),
      );
    expect(persisted).toHaveLength(0);
  });
});
