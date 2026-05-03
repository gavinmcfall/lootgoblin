/**
 * Unit tests for ledger-schemas — V2-007a-T12.
 *
 * Coverage:
 *   - Each registered kind: valid payload accepted, missing-field rejected,
 *     wrong-type rejected.
 *   - Pass-through: unknown kind → ok, undefined/null payload → ok.
 *   - Registry mutation: registerLedgerEventSchema adds + replaces.
 *   - Numeric-with-provenance arrays: per-item provenanceClass enforced.
 *   - Integration: persistLedgerEvent rejects malformed payloads (no row
 *     written, returns { eventId: null }).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import {
  validateLedgerEventPayload,
  getLedgerEventSchema,
  listRegisteredLedgerEventKinds,
  registerLedgerEventSchema,
} from '../../src/stash/ledger-schemas';
import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { persistLedgerEvent } from '../../src/stash/ledger';

// ---------------------------------------------------------------------------
// Per-kind sample-payload table — drives the parametric test loop.
// ---------------------------------------------------------------------------

interface KindCase {
  kind: string;
  /** A payload that MUST validate. */
  valid: Record<string, unknown>;
  /** Field names whose absence MUST cause rejection. */
  requiredFields: string[];
  /**
   * Field name + replacement value with a wrong type that MUST cause rejection.
   * Use a value that is the WRONG primitive class (string→number, etc).
   */
  wrongType: { field: string; value: unknown };
}

const cases: KindCase[] = [
  {
    kind: 'bulk.move-to-collection',
    valid: {
      action: { kind: 'move-to-collection', targetCollectionId: 'coll-1' },
      manifest: { applied: ['l1'], skipped: [], failed: [] },
      timestamp: '2026-04-25T00:00:00Z',
    },
    requiredFields: ['action', 'timestamp'],
    wrongType: { field: 'timestamp', value: 12345 },
  },
  {
    kind: 'bulk.change-template',
    valid: {
      action: { kind: 'change-template', newTemplate: '{creator}/{title}' },
      manifest: { applied: [], skipped: [], failed: [] },
      timestamp: '2026-04-25T00:00:00Z',
    },
    requiredFields: ['action', 'timestamp'],
    wrongType: { field: 'action', value: 'not-an-object' },
  },
  {
    kind: 'reconciler.removed-externally',
    valid: { lootId: 'loot-1', path: '/abs/path/file.stl' },
    requiredFields: ['lootId', 'path'],
    wrongType: { field: 'lootId', value: 42 },
  },
  {
    kind: 'reconciler.content-changed',
    valid: {
      lootId: 'loot-1',
      path: '/abs/path/file.stl',
      newHash: 'sha256:abc',
      newSize: 12345,
    },
    requiredFields: ['lootId', 'path', 'newHash', 'newSize'],
    wrongType: { field: 'newSize', value: '12345' },
  },
  {
    kind: 'migration.execute',
    valid: {
      lootFileId: 'lf-1',
      collectionId: 'coll-1',
      oldPath: 'old/p.stl',
      newPath: 'new/p.stl',
      timestamp: '2026-04-25T00:00:00Z',
    },
    requiredFields: ['lootFileId', 'oldPath', 'newPath'],
    wrongType: { field: 'newPath', value: 999 },
  },
  {
    kind: 'material.added',
    valid: {
      initialAmount: 1000,
      unit: 'g',
      kind: 'filament_spool',
      brand: 'Bambu',
      subtype: 'PLA',
      colors: ['#FF0000'],
      colorPattern: 'solid',
    },
    requiredFields: ['initialAmount', 'unit', 'kind'],
    wrongType: { field: 'initialAmount', value: '1000' },
  },
  {
    kind: 'material.retired',
    valid: {
      retirementReason: 'finished',
      remainingAtRetirement: 0,
      kind: 'filament_spool',
    },
    requiredFields: ['retirementReason', 'remainingAtRetirement', 'kind'],
    wrongType: { field: 'remainingAtRetirement', value: 'lots' },
  },
  {
    // V2-005f-CF-1 T_g2: payload migrated from free-text printerRef to the
    // structured (printerId, slotIndex, loadoutId) shape backed by
    // printer_loadouts. swappedOutMaterialId is set on atomic-swap.
    kind: 'material.loaded',
    valid: {
      printerId: 'printer-uuid',
      slotIndex: 0,
      loadoutId: 'loadout-uuid',
    },
    requiredFields: ['printerId', 'slotIndex', 'loadoutId'],
    wrongType: { field: 'slotIndex', value: 'two' },
  },
  {
    // V2-005f-CF-1 T_g2: same migration as material.loaded, plus a closed
    // 'manual' | 'swap' reason enum (no free-form strings allowed).
    kind: 'material.unloaded',
    valid: {
      printerId: 'printer-uuid',
      slotIndex: 0,
      loadoutId: 'loadout-uuid',
      reason: 'manual',
    },
    requiredFields: ['printerId', 'slotIndex', 'loadoutId', 'reason'],
    wrongType: { field: 'reason', value: 'unmounted' },
  },
  {
    kind: 'material.mix_created',
    valid: {
      totalVolume: 100,
      unit: 'ml',
      perComponentDraws: [
        { sourceMaterialId: 'm1', drawAmount: 50, provenanceClass: 'measured' },
        { sourceMaterialId: 'm2', drawAmount: 50, provenanceClass: 'entered' },
      ],
    },
    requiredFields: ['totalVolume', 'unit', 'perComponentDraws'],
    wrongType: { field: 'totalVolume', value: '100ml' },
  },
  {
    kind: 'material.recycled',
    valid: {
      inputs: [
        { sourceMaterialId: 'm1', weight: 200, provenanceClass: 'measured' },
        { sourceMaterialId: null, weight: 50, provenanceClass: 'estimated', note: 'scraps' },
      ],
      outputWeight: 240,
      sumInputs: 250,
      weightAnomaly: false,
      anomalyAck: false,
    },
    requiredFields: ['inputs', 'outputWeight', 'weightAnomaly', 'anomalyAck'],
    wrongType: { field: 'outputWeight', value: 'heavy' },
  },
  {
    kind: 'material.consumed',
    valid: {
      weightConsumed: 12.5,
      unit: 'g',
      attributedTo: { kind: 'print', jobId: 'job-1', lootId: 'loot-1' },
      source: 'forge:dispatch',
      newRemainingAmount: 987.5,
      reconciliationNeeded: false,
    },
    requiredFields: ['weightConsumed', 'unit', 'attributedTo', 'source'],
    wrongType: { field: 'reconciliationNeeded', value: 'no' },
  },
];

// ---------------------------------------------------------------------------
// Per-kind tests
// ---------------------------------------------------------------------------

describe('ledger-schemas — registered kinds', () => {
  for (const c of cases) {
    describe(c.kind, () => {
      it('accepts a valid payload', () => {
        const result = validateLedgerEventPayload(c.kind, c.valid);
        expect(result.ok).toBe(true);
      });

      for (const field of c.requiredFields) {
        it(`rejects when "${field}" is missing`, () => {
          const broken = { ...c.valid };
          delete (broken as Record<string, unknown>)[field];
          const result = validateLedgerEventPayload(c.kind, broken);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            // Error path mentions the missing field somewhere.
            const joined = result.issues.join('|');
            expect(joined.includes(field)).toBe(true);
          }
        });
      }

      it(`rejects when "${c.wrongType.field}" has the wrong type`, () => {
        const broken = { ...c.valid, [c.wrongType.field]: c.wrongType.value };
        const result = validateLedgerEventPayload(c.kind, broken);
        expect(result.ok).toBe(false);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Pass-through behaviour
// ---------------------------------------------------------------------------

describe('validateLedgerEventPayload — pass-through', () => {
  it('returns ok=true for an unregistered kind (forward compat)', () => {
    expect(validateLedgerEventPayload('forge.dispatch.completed', { foo: 1 })).toEqual({
      ok: true,
    });
  });

  it('returns ok=true when payload is undefined', () => {
    // Even for a registered kind: undefined payload is allowed by LedgerEvent.
    expect(validateLedgerEventPayload('material.added', undefined)).toEqual({ ok: true });
  });

  it('returns ok=true when payload is null', () => {
    expect(validateLedgerEventPayload('material.added', null)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Registry mutation
// ---------------------------------------------------------------------------

describe('registerLedgerEventSchema', () => {
  it('registers a new kind that previously passed through', () => {
    const kind = `test.custom-kind-${Math.random().toString(36).slice(2, 8)}`;
    expect(getLedgerEventSchema(kind)).toBeNull();
    expect(validateLedgerEventPayload(kind, { foo: 1 })).toEqual({ ok: true });

    registerLedgerEventSchema(kind, z.object({ foo: z.number() }));

    expect(getLedgerEventSchema(kind)).not.toBeNull();
    expect(validateLedgerEventPayload(kind, { foo: 1 }).ok).toBe(true);
    const bad = validateLedgerEventPayload(kind, { foo: 'not-a-number' });
    expect(bad.ok).toBe(false);
  });

  it('lists all default registered kinds', () => {
    const kinds = listRegisteredLedgerEventKinds();
    expect(kinds).toContain('material.added');
    expect(kinds).toContain('material.recycled');
    expect(kinds).toContain('bulk.move-to-collection');
    expect(kinds).toContain('migration.execute');
  });
});

// ---------------------------------------------------------------------------
// Numeric-with-provenance arrays
// ---------------------------------------------------------------------------

describe('numeric-with-provenance per-item validation', () => {
  it('rejects a mix draw missing provenanceClass', () => {
    const result = validateLedgerEventPayload('material.mix_created', {
      totalVolume: 100,
      unit: 'ml',
      perComponentDraws: [
        { sourceMaterialId: 'm1', drawAmount: 50, provenanceClass: 'measured' },
        { sourceMaterialId: 'm2', drawAmount: 50 }, // no provenanceClass
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a mix draw with an unknown provenanceClass enum value', () => {
    const result = validateLedgerEventPayload('material.mix_created', {
      totalVolume: 100,
      unit: 'ml',
      perComponentDraws: [
        { sourceMaterialId: 'm1', drawAmount: 50, provenanceClass: 'measured' },
        { sourceMaterialId: 'm2', drawAmount: 50, provenanceClass: 'guessed' },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a recycle input missing provenanceClass', () => {
    const result = validateLedgerEventPayload('material.recycled', {
      inputs: [{ sourceMaterialId: 'm1', weight: 100 }],
      outputWeight: 90,
      weightAnomaly: false,
      anomalyAck: false,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a recycle input with non-positive weight', () => {
    const result = validateLedgerEventPayload('material.recycled', {
      inputs: [{ sourceMaterialId: 'm1', weight: 0, provenanceClass: 'measured' }],
      outputWeight: 90,
      weightAnomaly: false,
      anomalyAck: false,
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration — persistLedgerEvent rejects bad payloads
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-ledger-schemas-unit.db';
const DB_URL = `file:${DB_PATH}`;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

describe('persistLedgerEvent — schema validation integration', () => {
  it('does NOT write the row when a registered payload fails validation', async () => {
    const result = await persistLedgerEvent(
      {
        kind: 'material.added',
        subjectType: 'material',
        subjectId: 'mat-fail-1',
        // Missing initialAmount + unit + kind — clearly invalid.
        payload: { brand: 'NoBrand' },
      },
      DB_URL,
    );

    expect(result.eventId).toBeNull();

    const db = getDb(DB_URL) as ReturnType<
      typeof import('drizzle-orm/better-sqlite3').drizzle
    >;
    const rows = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.subjectId, 'mat-fail-1'));
    expect(rows).toHaveLength(0);
  });

  it('writes the row when a registered payload passes validation', async () => {
    const result = await persistLedgerEvent(
      {
        kind: 'material.added',
        actorUserId: 'user-pass',
        subjectType: 'material',
        subjectId: 'mat-pass-1',
        provenanceClass: 'entered',
        payload: {
          initialAmount: 1000,
          unit: 'g',
          kind: 'filament_spool',
          brand: 'Bambu',
          subtype: 'PLA',
          colors: ['#000000'],
          colorPattern: 'solid',
        },
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();
  });

  it('writes the row for an unregistered kind regardless of payload shape', async () => {
    const result = await persistLedgerEvent(
      {
        kind: 'some.future.kind',
        subjectType: 'thing',
        subjectId: 'thing-1',
        payload: { whatever: { you: 'want' } },
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();
  });

  it('writes the row when payload is undefined even for a registered kind', async () => {
    const result = await persistLedgerEvent(
      {
        kind: 'material.added',
        subjectType: 'material',
        subjectId: 'mat-no-payload-1',
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();
  });
});
