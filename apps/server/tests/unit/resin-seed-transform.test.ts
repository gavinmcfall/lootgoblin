/**
 * Unit tests — resin seed transform (V2-007b T_B5b).
 *
 * Pure-function tests. No DB, no I/O.
 */

import { describe, it, expect } from 'vitest';

import {
  buildResinProductId,
  normalizeHex,
  normalizeResinMaterialClass,
  normalizeResinSubtype,
  transformResinSeed,
  type ResinSeedFile,
} from '../../src/scripts/_resin-seed-transform';

const ACTOR = 'system-importer';

// ---------------------------------------------------------------------------
// normalizeResinSubtype
// ---------------------------------------------------------------------------

describe('normalizeResinSubtype', () => {
  it('passes direct enum hits unchanged', () => {
    expect(normalizeResinSubtype('tough')).toEqual({ ok: true, subtype: 'tough' });
    expect(normalizeResinSubtype('standard')).toEqual({ ok: true, subtype: 'standard' });
    expect(normalizeResinSubtype('water-washable')).toEqual({
      ok: true,
      subtype: 'water-washable',
    });
    expect(normalizeResinSubtype('abs-like')).toEqual({ ok: true, subtype: 'abs-like' });
    expect(normalizeResinSubtype('plant-based')).toEqual({ ok: true, subtype: 'plant-based' });
    expect(normalizeResinSubtype('dental-Class-I')).toEqual({
      ok: true,
      subtype: 'dental-Class-I',
    });
  });

  it('normalises common typos and capitalisations', () => {
    expect(normalizeResinSubtype('Tough').ok).toBe(true);
    expect(normalizeResinSubtype('Tough')).toEqual({ ok: true, subtype: 'tough' });
    expect(normalizeResinSubtype('Water Washable')).toEqual({
      ok: true,
      subtype: 'water-washable',
    });
    expect(normalizeResinSubtype('ABS Like')).toEqual({ ok: true, subtype: 'abs-like' });
    expect(normalizeResinSubtype('Plant Based')).toEqual({
      ok: true,
      subtype: 'plant-based',
    });
    expect(normalizeResinSubtype('High Temp')).toEqual({ ok: true, subtype: 'high-temp' });
  });

  it("rejects unknown subtypes with reason 'invalid-subtype'", () => {
    const r = normalizeResinSubtype('MysteryType');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('invalid-subtype');
    }
  });

  it('rejects empty / non-string', () => {
    expect(normalizeResinSubtype('').ok).toBe(false);
    expect(normalizeResinSubtype(undefined).ok).toBe(false);
    expect(normalizeResinSubtype(null).ok).toBe(false);
    expect(normalizeResinSubtype(42).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeResinMaterialClass
// ---------------------------------------------------------------------------

describe('normalizeResinMaterialClass', () => {
  it('passes valid classes through', () => {
    expect(normalizeResinMaterialClass('consumer')).toBe('consumer');
    expect(normalizeResinMaterialClass('industrial')).toBe('industrial');
    expect(normalizeResinMaterialClass('medical-Class-I')).toBe('medical-Class-I');
    expect(normalizeResinMaterialClass('medical-Class-IIa')).toBe('medical-Class-IIa');
  });

  it('returns null for missing or invalid values', () => {
    expect(normalizeResinMaterialClass(undefined)).toBeNull();
    expect(normalizeResinMaterialClass(null)).toBeNull();
    expect(normalizeResinMaterialClass('hobbyist')).toBeNull();
    expect(normalizeResinMaterialClass(123)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeHex
// ---------------------------------------------------------------------------

describe('normalizeHex', () => {
  it('uppercases + prepends #', () => {
    expect(normalizeHex('ff6600')).toBe('#FF6600');
    expect(normalizeHex('#ff6600')).toBe('#FF6600');
    expect(normalizeHex('FF6600')).toBe('#FF6600');
  });

  it('rejects bad hex', () => {
    expect(normalizeHex('XYZ123')).toBeNull();
    expect(normalizeHex('#12')).toBeNull();
    expect(normalizeHex('1234567')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildResinProductId
// ---------------------------------------------------------------------------

describe('buildResinProductId', () => {
  it('builds the system:community-pr slug pattern', () => {
    expect(buildResinProductId('Prusa Polymers', 'Prusament Resin Tough', 'Prusa Orange')).toBe(
      'system:community-pr:prusa-polymers:prusament-resin-tough:prusa-orange',
    );
  });

  it('handles empty product line via slugify "unknown" sentinel', () => {
    expect(buildResinProductId('Brand', '', 'Color')).toBe(
      'system:community-pr:brand:unknown:color',
    );
  });

  it('is deterministic across calls (idempotent ids)', () => {
    const a = buildResinProductId('A', 'B', 'C');
    const b = buildResinProductId('A', 'B', 'C');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// transformResinSeed — happy path
// ---------------------------------------------------------------------------

describe('transformResinSeed — happy path', () => {
  it('transforms a full-shape product into a CreateResinProductInput', () => {
    const file: ResinSeedFile = {
      brand: 'Brand X',
      products: [
        {
          productLine: 'Line One',
          subtype: 'tough',
          colors: ['#FF6600'],
          colorName: 'Orange',
          defaultExposure: {
            layer_height_mm: 0.05,
            exposure_seconds: 7,
          },
          densityGMl: 1.13,
          viscosityCps: 350,
          bottleVolumeMl: 1000,
          compatibility: { wavelength_nm: 405 },
          materialClass: 'consumer',
          retailUrl: 'https://brand-x.test/line-one',
          sourceRef: 'https://brand-x.test/line-one',
        },
      ],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.id).toBe('system:community-pr:brand-x:line-one:orange');
    expect(r.input.brand).toBe('Brand X');
    expect(r.input.productLine).toBe('Line One');
    expect(r.input.subtype).toBe('tough');
    expect(r.input.colors).toEqual(['#FF6600']);
    expect(r.input.colorName).toBe('Orange');
    expect(r.input.defaultExposure).toEqual({
      layer_height_mm: 0.05,
      exposure_seconds: 7,
    });
    expect(r.input.densityGMl).toBe(1.13);
    expect(r.input.viscosityCps).toBe(350);
    expect(r.input.bottleVolumeMl).toBe(1000);
    expect(r.input.compatibility).toEqual({ wavelength_nm: 405 });
    expect(r.input.materialClass).toBe('consumer');
    expect(r.input.retailUrl).toBe('https://brand-x.test/line-one');
    expect(r.input.sourceRef).toBe('https://brand-x.test/line-one');
    expect(r.input.source).toBe('community-pr');
    expect(r.input.ownerId).toBeNull();
    expect(r.input.actorRole).toBe('admin');
    expect(r.input.actorUserId).toBe(ACTOR);
  });

  it('handles missing optional fields cleanly (no undefined leakage)', () => {
    const file: ResinSeedFile = {
      brand: 'Brand Y',
      products: [
        {
          subtype: 'standard',
        },
      ],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.brand).toBe('Brand Y');
    expect(r.input.subtype).toBe('standard');
    // No colorName → id seeded from subtype.
    expect(r.input.id).toBe('system:community-pr:brand-y:unknown:standard');
    // Optional fields should not be set (undefined).
    expect(r.input.productLine).toBeUndefined();
    expect(r.input.colorName).toBeUndefined();
    expect(r.input.defaultExposure).toBeUndefined();
    expect(r.input.densityGMl).toBeUndefined();
    expect(r.input.viscosityCps).toBeUndefined();
    expect(r.input.bottleVolumeMl).toBeUndefined();
    expect(r.input.compatibility).toBeUndefined();
    expect(r.input.materialClass).toBeUndefined();
    expect(r.input.retailUrl).toBeUndefined();
    expect(r.input.sourceRef).toBeUndefined();
    // Colors missing → null.
    expect(r.input.colors).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transformResinSeed — subtype validation
// ---------------------------------------------------------------------------

describe('transformResinSeed — subtype validation', () => {
  it("rejects MysteryType with reason='invalid-subtype'", () => {
    const file: ResinSeedFile = {
      brand: 'Brand Z',
      products: [{ subtype: 'MysteryType' }],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-subtype');
  });

  it('normalizes "Tough" → "tough"', () => {
    const file: ResinSeedFile = {
      brand: 'Brand Z',
      products: [{ subtype: 'Tough', colorName: 'Orange' }],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.input.subtype).toBe('tough');
    }
  });

  it('normalizes "Water Washable" → "water-washable"', () => {
    const file: ResinSeedFile = {
      brand: 'Brand Z',
      products: [{ subtype: 'Water Washable', colorName: 'Clear' }],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.input.subtype).toBe('water-washable');
    }
  });

  it('passes "abs-like" through (mainstream subtype)', () => {
    const file: ResinSeedFile = {
      brand: 'Brand Z',
      products: [{ subtype: 'abs-like', colorName: 'Black' }],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.input.subtype).toBe('abs-like');
    }
  });
});

// ---------------------------------------------------------------------------
// transformResinSeed — material-class normalisation
// ---------------------------------------------------------------------------

describe('transformResinSeed — materialClass normalisation', () => {
  it('keeps valid materialClass', () => {
    const file: ResinSeedFile = {
      brand: 'B',
      products: [{ subtype: 'standard', materialClass: 'industrial' }],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.input.materialClass).toBe('industrial');
    }
  });

  it('drops invalid materialClass while keeping the product', () => {
    const file: ResinSeedFile = {
      brand: 'B',
      products: [
        {
          subtype: 'standard',
          colorName: 'Grey',
          materialClass: 'hobbyist',
        },
      ],
    };
    const results = transformResinSeed(file, ACTOR);
    const r = results[0]!;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.materialClass).toBeUndefined();
    // Product still emitted.
    expect(r.input.subtype).toBe('standard');
  });
});

// ---------------------------------------------------------------------------
// transformResinSeed — id behaviour
// ---------------------------------------------------------------------------

describe('transformResinSeed — id auto-generation', () => {
  it('auto-generates when id omitted', () => {
    const file: ResinSeedFile = {
      brand: 'Prusa Polymers',
      products: [
        {
          productLine: 'Prusament Resin Tough',
          subtype: 'tough',
          colorName: 'Prusa Orange',
        },
      ],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.input.id).toBe(
        'system:community-pr:prusa-polymers:prusament-resin-tough:prusa-orange',
      );
    }
  });

  it('respects explicit id when provided', () => {
    const file: ResinSeedFile = {
      brand: 'Brand',
      products: [
        {
          id: 'system:community-pr:brand:custom:slug',
          subtype: 'tough',
          colorName: 'Orange',
        },
      ],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.input.id).toBe('system:community-pr:brand:custom:slug');
    }
  });

  it('falls back to subtype-based slug when colorName missing', () => {
    const file: ResinSeedFile = {
      brand: 'Brand',
      products: [{ productLine: 'Generic', subtype: 'standard' }],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.input.id).toBe(
        'system:community-pr:brand:generic:standard',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// transformResinSeed — colors normalisation
// ---------------------------------------------------------------------------

describe('transformResinSeed — colors normalisation', () => {
  it('normalises hex case + prefix', () => {
    const file: ResinSeedFile = {
      brand: 'B',
      products: [
        { subtype: 'standard', colorName: 'X', colors: ['ff6600'] },
      ],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.input.colors).toEqual(['#FF6600']);
    }
  });

  it('treats null/undefined colors as null (legitimate for industrial resins)', () => {
    const file: ResinSeedFile = {
      brand: 'B',
      products: [
        { subtype: 'casting', colors: null, materialClass: 'industrial' },
        { subtype: 'engineering' },
      ],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results.every((r) => r.ok)).toBe(true);
    for (const r of results) {
      if (r.ok) expect(r.input.colors).toBeNull();
    }
  });

  it('drops invalid hexes (and falls to null when all dropped)', () => {
    const file: ResinSeedFile = {
      brand: 'B',
      products: [
        { subtype: 'standard', colorName: 'AllBad', colors: ['XYZXYZ', 'NOPE12'] },
        { subtype: 'standard', colorName: 'Mixed', colors: ['XYZ', '#00AA00'] },
      ],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results.every((r) => r.ok)).toBe(true);
    if (results[0]!.ok) expect(results[0]!.input.colors).toBeNull();
    if (results[1]!.ok) expect(results[1]!.input.colors).toEqual(['#00AA00']);
  });

  it('multi-color resin (rare but allowed): array length 2 OK; colorPattern is not enforced for resin', () => {
    const file: ResinSeedFile = {
      brand: 'B',
      products: [
        { subtype: 'standard', colorName: 'Chrome', colors: ['#C0C0C0', '#000000'] },
      ],
    };
    const results = transformResinSeed(file, ACTOR);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.input.colors).toEqual(['#C0C0C0', '#000000']);
    }
  });
});

// ---------------------------------------------------------------------------
// transformResinSeed — file-level shape errors
// ---------------------------------------------------------------------------

describe('transformResinSeed — file shape errors', () => {
  it('returns brand-required error per product when brand missing', () => {
    const file = {
      products: [{ subtype: 'tough' }],
    } as unknown as ResinSeedFile;
    const results = transformResinSeed(file, ACTOR);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) {
      expect(results[0]!.reason).toBe('brand-required');
    }
  });

  it('returns [] when products is not an array', () => {
    const file = {
      brand: 'B',
      products: 'oops',
    } as unknown as ResinSeedFile;
    const results = transformResinSeed(file, ACTOR);
    expect(results).toEqual([]);
  });
});
