/**
 * Unit tests — catalog CRUD (V2-007b T_B2).
 *
 * Real-DB-on-tmpfile pattern (matches V2-007a-T4). Covers the full
 * source/owner/role discipline + read visibility + write authorization
 * across createFilamentProduct + updateFilamentProduct + deleteFilamentProduct
 * + listFilamentProducts + searchFilamentProducts (and the resin parallel
 * surface).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  createFilamentProduct,
  updateFilamentProduct,
  deleteFilamentProduct,
  listFilamentProducts,
  searchFilamentProducts,
  getFilamentProduct,
  createResinProduct,
  updateResinProduct,
  deleteResinProduct,
  listResinProducts,
  searchResinProducts,
} from '../../src/materials/catalog';

const DB_PATH = '/tmp/lootgoblin-catalog-crud-unit.db';
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
    name: 'Catalog Test User',
    email: `${id}@catalog.test`,
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

// ═══════════════════════════════════════════════════════════════════════════
// FILAMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('createFilamentProduct', () => {
  it('1. user creates custom entry (ownerId=actor.id, source=user)', async () => {
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'Custom Maker',
        subtype: 'PLA',
        colors: ['#FF0000'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.product.ownerId).toBe(userId);
    expect(r.product.source).toBe('user');
    expect(r.product.colors).toEqual(['#FF0000']);
  });

  it('2. admin creates system entry (ownerId=NULL, source=system:spoolmandb)', async () => {
    const adminId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'Bambu Lab',
        productLine: 'PLA Basic',
        subtype: 'PLA',
        colors: ['#1E90FF'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.product.ownerId).toBeNull();
    expect(r.product.source).toBe('system:spoolmandb');
  });

  it('3. source=user + ownerId=NULL rejects with source-owner-mismatch', async () => {
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'X',
        subtype: 'PLA',
        colors: ['#000000'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: null,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-owner-mismatch');
  });

  it('4. source=system:spoolmandb + ownerId set rejects with source-owner-mismatch', async () => {
    const adminId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'X',
        subtype: 'PLA',
        colors: ['#000000'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: adminId,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-owner-mismatch');
  });

  it('5. non-admin trying to create system entry rejects with admin-required', async () => {
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'X',
        subtype: 'PLA',
        colors: ['#000000'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('admin-required');
  });

  it('6. user trying to set ownerId=other-user rejects with cannot-impersonate-owner', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'X',
        subtype: 'PLA',
        colors: ['#000000'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userB,
        actorUserId: userA,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('cannot-impersonate-owner');
  });

  it('7. invalid subtype rejects with invalid-subtype', async () => {
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'X',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        subtype: 'NOT-A-REAL-SUBTYPE' as any,
        colors: ['#000000'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-subtype');
  });

  it('8a. too many colors rejects with colors-too-many', async () => {
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'X',
        subtype: 'PLA',
        colors: ['#000000', '#111111', '#222222', '#333333', '#444444'],
        colorPattern: 'multi-section',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('colors-too-many');
  });

  it('8b. malformed hex rejects with color-format', async () => {
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'X',
        subtype: 'PLA',
        colors: ['not-hex'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('color-format');
  });

  it('8c. solid pattern with 2 colors rejects with color-pattern-mismatch', async () => {
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'X',
        subtype: 'PLA',
        colors: ['#000000', '#FFFFFF'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('color-pattern-mismatch');
  });

  it('9. invalid source rejects with invalid-source', async () => {
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'X',
        subtype: 'PLA',
        colors: ['#000000'],
        colorPattern: 'solid',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: 'definitely-not-a-source' as any,
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-source');
  });

  it('10a. idempotent re-create with same id + same body returns existing (replayed=true)', async () => {
    const adminId = await seedUser();
    const stableId = `seed:bambu-pla-basic-red-${uid()}`;
    const body = {
      brand: 'Bambu Lab',
      subtype: 'PLA' as const,
      colors: ['#E63946'],
      colorPattern: 'solid' as const,
      source: 'system:spoolmandb' as const,
      ownerId: null,
      actorUserId: adminId,
      actorRole: 'admin' as const,
      id: stableId,
    };
    const first = await createFilamentProduct(body, { dbUrl: DB_URL });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replayed).toBe(false);

    const second = await createFilamentProduct(body, { dbUrl: DB_URL });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.productId).toBe(first.productId);
  });

  it('10b. idempotent re-create with same id + different body rejects with id-conflict', async () => {
    const adminId = await seedUser();
    const stableId = `seed:bambu-pla-basic-blue-${uid()}`;
    const first = await createFilamentProduct(
      {
        brand: 'Bambu Lab',
        subtype: 'PLA',
        colors: ['#0000FF'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
        id: stableId,
      },
      { dbUrl: DB_URL },
    );
    expect(first.ok).toBe(true);

    const second = await createFilamentProduct(
      {
        brand: 'Bambu Lab',
        subtype: 'PLA',
        colors: ['#FF0000'], // different color
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
        id: stableId,
      },
      { dbUrl: DB_URL },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('id-conflict');
  });
});

describe('updateFilamentProduct', () => {
  it('11. user updates their own custom entry', async () => {
    const userId = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'Custom',
        subtype: 'PLA',
        colors: ['#000000'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const upd = await updateFilamentProduct(
      {
        id: created.productId,
        actorUserId: userId,
        actorRole: 'user',
        patch: { brand: 'Updated Brand' },
      },
      { dbUrl: DB_URL },
    );
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    expect(upd.product.brand).toBe('Updated Brand');
  });

  it('12. non-admin user CANNOT update system entry (admin-required)', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'Bambu',
        subtype: 'PLA',
        colors: ['#111111'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const upd = await updateFilamentProduct(
      {
        id: created.productId,
        actorUserId: userId,
        actorRole: 'user',
        patch: { brand: 'Hacked' },
      },
      { dbUrl: DB_URL },
    );
    expect(upd.ok).toBe(false);
    if (upd.ok) return;
    expect(upd.reason).toBe('admin-required');
  });

  it('13. admin can update system entry', async () => {
    const adminId = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'Bambu',
        subtype: 'PLA',
        colors: ['#222222'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const upd = await updateFilamentProduct(
      {
        id: created.productId,
        actorUserId: adminId,
        actorRole: 'admin',
        patch: { density: 1.24 },
      },
      { dbUrl: DB_URL },
    );
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    expect(upd.product.density).toBe(1.24);
  });

  it('14. admin CANNOT update another user’s custom entry (privacy → not-found)', async () => {
    const userA = await seedUser();
    const adminId = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'Custom',
        subtype: 'PLA',
        colors: ['#333333'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userA,
        actorUserId: userA,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const upd = await updateFilamentProduct(
      {
        id: created.productId,
        actorUserId: adminId,
        actorRole: 'admin',
        patch: { brand: 'X' },
      },
      { dbUrl: DB_URL },
    );
    expect(upd.ok).toBe(false);
    if (upd.ok) return;
    expect(upd.reason).toBe('not-found');
  });

  it('15. cross-owner non-admin update returns not-found', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'A',
        subtype: 'PLA',
        colors: ['#444444'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userA,
        actorUserId: userA,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const upd = await updateFilamentProduct(
      {
        id: created.productId,
        actorUserId: userB,
        actorRole: 'user',
        patch: { brand: 'X' },
      },
      { dbUrl: DB_URL },
    );
    expect(upd.ok).toBe(false);
    if (upd.ok) return;
    expect(upd.reason).toBe('not-found');
  });
});

describe('deleteFilamentProduct', () => {
  it('16. user deletes their own custom entry', async () => {
    const userId = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'X',
        subtype: 'PLA',
        colors: ['#555555'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const del = await deleteFilamentProduct(
      { id: created.productId, actorUserId: userId, actorRole: 'user' },
      { dbUrl: DB_URL },
    );
    expect(del.ok).toBe(true);
  });

  it('17. admin deletes system entry', async () => {
    const adminId = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'B',
        subtype: 'PLA',
        colors: ['#666666'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const del = await deleteFilamentProduct(
      { id: created.productId, actorUserId: adminId, actorRole: 'admin' },
      { dbUrl: DB_URL },
    );
    expect(del.ok).toBe(true);
  });

  it('18. cross-owner delete returns not-found', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'C',
        subtype: 'PLA',
        colors: ['#777777'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userA,
        actorUserId: userA,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const del = await deleteFilamentProduct(
      { id: created.productId, actorUserId: userB, actorRole: 'user' },
      { dbUrl: DB_URL },
    );
    expect(del.ok).toBe(false);
    if (del.ok) return;
    expect(del.reason).toBe('not-found');
  });
});

describe('listFilamentProducts visibility + filters', () => {
  it('19. user sees their own custom + system entries; not other users’ customs', async () => {
    const adminId = await seedUser();
    const userA = await seedUser();
    const userB = await seedUser();

    const sys = await createFilamentProduct(
      {
        brand: 'List-Sys-Brand',
        subtype: 'PLA',
        colors: ['#100000'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(sys.ok).toBe(true);

    const own = await createFilamentProduct(
      {
        brand: 'List-OwnA-Brand',
        subtype: 'PLA',
        colors: ['#100001'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userA,
        actorUserId: userA,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(own.ok).toBe(true);

    const otherCustom = await createFilamentProduct(
      {
        brand: 'List-OwnB-Brand',
        subtype: 'PLA',
        colors: ['#100002'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userB,
        actorUserId: userB,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(otherCustom.ok).toBe(true);
    if (!sys.ok || !own.ok || !otherCustom.ok) return;

    const list = await listFilamentProducts(
      { actorUserId: userA, actorRole: 'user', limit: 200 },
      { dbUrl: DB_URL },
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const ids = new Set(list.products.map((p) => p.id));
    expect(ids.has(sys.productId)).toBe(true);
    expect(ids.has(own.productId)).toBe(true);
    expect(ids.has(otherCustom.productId)).toBe(false);
  });

  it('20. admin sees system entries + own customs; still no cross-owner customs', async () => {
    const adminId = await seedUser();
    const userC = await seedUser();
    const cross = await createFilamentProduct(
      {
        brand: 'Z-cross-owner',
        subtype: 'PLA',
        colors: ['#200000'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userC,
        actorUserId: userC,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(cross.ok).toBe(true);
    if (!cross.ok) return;

    const list = await listFilamentProducts(
      { actorUserId: adminId, actorRole: 'admin', limit: 200 },
      { dbUrl: DB_URL },
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const ids = new Set(list.products.map((p) => p.id));
    expect(ids.has(cross.productId)).toBe(false);
  });

  it('21. filter by brand', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();
    const a = await createFilamentProduct(
      {
        brand: 'FilterBrandX',
        subtype: 'PETG',
        colors: ['#300000'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(a.ok).toBe(true);
    const b = await createFilamentProduct(
      {
        brand: 'OtherBrand',
        subtype: 'PETG',
        colors: ['#300001'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(b.ok).toBe(true);

    const list = await listFilamentProducts(
      {
        actorUserId: userId,
        actorRole: 'user',
        brand: 'FilterBrandX',
        limit: 200,
      },
      { dbUrl: DB_URL },
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    for (const p of list.products) expect(p.brand).toBe('FilterBrandX');
  });

  it('22. filter by subtype', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();
    const a = await createFilamentProduct(
      {
        brand: 'B1',
        subtype: 'TPU-95A',
        colors: ['#400000'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(a.ok).toBe(true);
    const list = await listFilamentProducts(
      {
        actorUserId: userId,
        actorRole: 'user',
        subtype: 'TPU-95A',
        limit: 200,
      },
      { dbUrl: DB_URL },
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.products.length).toBeGreaterThan(0);
    for (const p of list.products) expect(p.subtype).toBe('TPU-95A');
  });

  it('23. cursor pagination', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    // Create 5 entries with stable lex-ordered ids so paging deterministic.
    const tag = `pag-${uid().slice(0, 8)}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `${tag}-${i.toString().padStart(2, '0')}`;
      const r = await createFilamentProduct(
        {
          brand: `BrandPag-${i}`,
          subtype: 'PLA',
          colors: ['#500000'],
          colorPattern: 'solid',
          source: 'system:spoolmandb',
          ownerId: null,
          actorUserId: adminId,
          actorRole: 'admin',
          id,
        },
        { dbUrl: DB_URL },
      );
      expect(r.ok).toBe(true);
      ids.push(id);
    }
    // Page 1: limit 2.
    const p1 = await listFilamentProducts(
      {
        actorUserId: userId,
        actorRole: 'user',
        limit: 2,
        cursor: ids[0]!.replace(/.$/, ''), // start before our first id (lex)
      },
      { dbUrl: DB_URL },
    );
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.products.length).toBe(2);
    expect(p1.nextCursor).not.toBeNull();
    expect(p1.products[0]!.id).toBe(ids[0]);
    expect(p1.products[1]!.id).toBe(ids[1]);

    const p2 = await listFilamentProducts(
      {
        actorUserId: userId,
        actorRole: 'user',
        limit: 2,
        cursor: p1.nextCursor!,
      },
      { dbUrl: DB_URL },
    );
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    expect(p2.products[0]!.id).toBe(ids[2]);
  });
});

describe('searchFilamentProducts', () => {
  it('24. prefix match on brand', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'BambuSearch Lab',
        productLine: 'PLA Basic',
        subtype: 'PLA',
        colors: ['#600000'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    const s = await searchFilamentProducts(
      { actorUserId: userId, actorRole: 'user', prefix: 'BambuSearch' },
      { dbUrl: DB_URL },
    );
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.products.some((p) => p.brand === 'BambuSearch Lab')).toBe(true);
  });

  it('25. case-insensitive', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const r = await createFilamentProduct(
      {
        brand: 'Polymaker-CI',
        subtype: 'PLA',
        colors: ['#700000'],
        colorPattern: 'solid',
        source: 'system:spoolmandb',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    const s = await searchFilamentProducts(
      { actorUserId: userId, actorRole: 'user', prefix: 'polymaker-ci' },
      { dbUrl: DB_URL },
    );
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.products.some((p) => p.brand === 'Polymaker-CI')).toBe(true);
  });

  it('26. limit respected', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const tag = `limit-${uid().slice(0, 6)}`;
    for (let i = 0; i < 5; i++) {
      const r = await createFilamentProduct(
        {
          brand: `${tag}-brand-${i}`,
          subtype: 'PLA',
          colors: ['#800000'],
          colorPattern: 'solid',
          source: 'system:spoolmandb',
          ownerId: null,
          actorUserId: adminId,
          actorRole: 'admin',
        },
        { dbUrl: DB_URL },
      );
      expect(r.ok).toBe(true);
    }
    const s = await searchFilamentProducts(
      { actorUserId: userId, actorRole: 'user', prefix: tag, limit: 3 },
      { dbUrl: DB_URL },
    );
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.products.length).toBe(3);
  });

  it('27. cross-owner customs not in autocomplete', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const tag = `xowner-${uid().slice(0, 6)}`;
    const r = await createFilamentProduct(
      {
        brand: `${tag}-secret`,
        subtype: 'PLA',
        colors: ['#900000'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userA,
        actorUserId: userA,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    const s = await searchFilamentProducts(
      { actorUserId: userB, actorRole: 'user', prefix: tag },
      { dbUrl: DB_URL },
    );
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.products.length).toBe(0);
  });
});

describe('getFilamentProduct visibility', () => {
  it('28. owner gets their own custom entry', async () => {
    const userId = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'Get-Own',
        subtype: 'PLA',
        colors: ['#A00000'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const got = await getFilamentProduct(
      { id: created.productId, actorUserId: userId, actorRole: 'user' },
      { dbUrl: DB_URL },
    );
    expect(got.ok).toBe(true);
  });

  it('29. cross-owner get returns not-found', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const created = await createFilamentProduct(
      {
        brand: 'Get-Cross',
        subtype: 'PLA',
        colors: ['#B00000'],
        colorPattern: 'solid',
        source: 'user',
        ownerId: userA,
        actorUserId: userA,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const got = await getFilamentProduct(
      { id: created.productId, actorUserId: userB, actorRole: 'user' },
      { dbUrl: DB_URL },
    );
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toBe('not-found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESIN
// ═══════════════════════════════════════════════════════════════════════════

describe('resin CRUD', () => {
  it('R1. user creates custom resin entry', async () => {
    const userId = await seedUser();
    const r = await createResinProduct(
      {
        brand: 'ResinCustom',
        subtype: 'standard',
        colors: ['#C00000'],
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.product.colors).toEqual(['#C00000']);
  });

  it('R2. resin colors=null is accepted', async () => {
    const adminId = await seedUser();
    const r = await createResinProduct(
      {
        brand: 'NoColorResin',
        subtype: 'dental-Class-II',
        colors: null,
        source: 'system:polymaker-preset',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.product.colors).toBeNull();
  });

  it('R3. admin creates system resin entry', async () => {
    const adminId = await seedUser();
    const r = await createResinProduct(
      {
        brand: 'Prusa Polymers',
        productLine: 'Tough',
        subtype: 'tough',
        materialClass: 'consumer',
        source: 'system:polymaker-preset',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.product.materialClass).toBe('consumer');
  });

  it('R4. invalid resin subtype rejects', async () => {
    const userId = await seedUser();
    const r = await createResinProduct(
      {
        brand: 'X',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        subtype: 'fake-subtype' as any,
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-subtype');
  });

  it('R5. invalid material class rejects', async () => {
    const userId = await seedUser();
    const r = await createResinProduct(
      {
        brand: 'X',
        subtype: 'standard',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        materialClass: 'made-up' as any,
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-material-class');
  });

  it('R6. user updates own resin entry', async () => {
    const userId = await seedUser();
    const c = await createResinProduct(
      {
        brand: 'UpdMe',
        subtype: 'standard',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const u = await updateResinProduct(
      {
        id: c.productId,
        actorUserId: userId,
        actorRole: 'user',
        patch: { brand: 'UpdMe-2' },
      },
      { dbUrl: DB_URL },
    );
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.product.brand).toBe('UpdMe-2');
  });

  it('R7. non-admin cannot update system resin entry', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const c = await createResinProduct(
      {
        brand: 'SysResin',
        subtype: 'standard',
        source: 'system:polymaker-preset',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const u = await updateResinProduct(
      {
        id: c.productId,
        actorUserId: userId,
        actorRole: 'user',
        patch: { brand: 'X' },
      },
      { dbUrl: DB_URL },
    );
    expect(u.ok).toBe(false);
    if (u.ok) return;
    expect(u.reason).toBe('admin-required');
  });

  it('R8. user deletes own resin entry', async () => {
    const userId = await seedUser();
    const c = await createResinProduct(
      {
        brand: 'DelMe',
        subtype: 'standard',
        source: 'user',
        ownerId: userId,
        actorUserId: userId,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const d = await deleteResinProduct(
      { id: c.productId, actorUserId: userId, actorRole: 'user' },
      { dbUrl: DB_URL },
    );
    expect(d.ok).toBe(true);
  });

  it('R9. list visibility: own + system; no cross-owner customs', async () => {
    const adminId = await seedUser();
    const userA = await seedUser();
    const userB = await seedUser();
    const sys = await createResinProduct(
      {
        brand: 'ListSys',
        subtype: 'standard',
        source: 'system:polymaker-preset',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    const own = await createResinProduct(
      {
        brand: 'ListOwn',
        subtype: 'standard',
        source: 'user',
        ownerId: userA,
        actorUserId: userA,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    const cross = await createResinProduct(
      {
        brand: 'ListCross',
        subtype: 'standard',
        source: 'user',
        ownerId: userB,
        actorUserId: userB,
        actorRole: 'user',
      },
      { dbUrl: DB_URL },
    );
    expect(sys.ok && own.ok && cross.ok).toBe(true);
    if (!sys.ok || !own.ok || !cross.ok) return;
    const list = await listResinProducts(
      { actorUserId: userA, actorRole: 'user', limit: 200 },
      { dbUrl: DB_URL },
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const ids = new Set(list.products.map((p) => p.id));
    expect(ids.has(sys.productId)).toBe(true);
    expect(ids.has(own.productId)).toBe(true);
    expect(ids.has(cross.productId)).toBe(false);
  });

  it('R10. resin search prefix on brand', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const r = await createResinProduct(
      {
        brand: 'SearchableResin',
        subtype: 'standard',
        source: 'system:polymaker-preset',
        ownerId: null,
        actorUserId: adminId,
        actorRole: 'admin',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    const s = await searchResinProducts(
      { actorUserId: userId, actorRole: 'user', prefix: 'searchableresin' },
      { dbUrl: DB_URL },
    );
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.products.some((p) => p.brand === 'SearchableResin')).toBe(true);
  });
});
