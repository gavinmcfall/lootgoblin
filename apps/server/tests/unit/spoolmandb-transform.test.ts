/**
 * Unit tests — SpoolmanDB transform + slug helper (V2-007b T_B5a).
 *
 * Pure-function tests. No DB, no fetch.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { slugify } from '../../src/scripts/_slug';
import {
  transformSpoolmanDbFilament,
  buildFilamentProductId,
  mapMaterialToSubtype,
  normalizeHex,
  type SpoolmanDbBrandFile,
} from '../../src/scripts/_spoolmandb-transform';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/spoolmandb');

function loadBambu(): SpoolmanDbBrandFile {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, 'Bambu.json'), 'utf-8');
  return JSON.parse(raw) as SpoolmanDbBrandFile;
}

const CTX = {
  commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  sourcePath: 'filaments/Bambu.json',
};
const ACTOR = 'system-importer';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Bambu Lab')).toBe('bambu-lab');
    expect(slugify('PLA Basic')).toBe('pla-basic');
  });

  it('strips non-alphanumeric', () => {
    expect(slugify('Velvet Eclipse!')).toBe('velvet-eclipse');
    expect(slugify('PLA+ (silk)')).toBe('pla-silk');
    expect(slugify('hello///world')).toBe('hello-world');
  });

  it('collapses runs of separators', () => {
    expect(slugify('a   b   c')).toBe('a-b-c');
    expect(slugify('a---b')).toBe('a-b');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
    expect(slugify('!!!world!!!')).toBe('world');
  });

  it('handles empty / all-special-chars input', () => {
    expect(slugify('')).toBe('unknown');
    // All special chars should still produce a deterministic slug.
    const s = slugify('!@#$%^&*()');
    expect(s).toMatch(/^x-[0-9a-f]{8}$/);
    // Same input -> same slug.
    expect(slugify('!@#$%^&*()')).toBe(s);
  });

  it('truncates with hash for long inputs (>80 chars)', () => {
    const long = 'a'.repeat(150);
    const s = slugify(long);
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s).toMatch(/-[0-9a-f]{8}$/);
    // Idempotent.
    expect(slugify(long)).toBe(s);
  });

  it('different long inputs produce different slugs (hash differentiates)', () => {
    const a = slugify('a'.repeat(150));
    const b = slugify('b'.repeat(150));
    expect(a).not.toBe(b);
  });
});

describe('mapMaterialToSubtype', () => {
  it('maps direct enum hits', () => {
    expect(mapMaterialToSubtype('PLA')).toEqual({ subtype: 'PLA', matched: true });
    expect(mapMaterialToSubtype('PETG-CF')).toEqual({ subtype: 'PETG-CF', matched: true });
    expect(mapMaterialToSubtype('PA12-CF')).toEqual({ subtype: 'PA12-CF', matched: true });
  });

  it('handles common aliases', () => {
    expect(mapMaterialToSubtype('PLA Plus').subtype).toBe('PLA+');
    expect(mapMaterialToSubtype('pla+').subtype).toBe('PLA+');
    expect(mapMaterialToSubtype('PLA Silk').subtype).toBe('PLA-Silk');
    expect(mapMaterialToSubtype('petg-cf').subtype).toBe('PETG-CF');
    expect(mapMaterialToSubtype('TPU 95A').subtype).toBe('TPU-95A');
  });

  it("falls back to 'other' on unknowns (matched=false)", () => {
    const r = mapMaterialToSubtype('Mystery Material');
    expect(r.subtype).toBe('other');
    expect(r.matched).toBe(false);
  });

  it("treats lowercase 'pla' as a match (uppercase normalization)", () => {
    expect(mapMaterialToSubtype('pla').subtype).toBe('PLA');
  });
});

describe('normalizeHex', () => {
  it('uppercases + prepends #', () => {
    expect(normalizeHex('00AE42')).toBe('#00AE42');
    expect(normalizeHex('00ae42')).toBe('#00AE42');
    expect(normalizeHex('#aabbcc')).toBe('#AABBCC');
  });

  it('rejects invalid hex', () => {
    expect(normalizeHex('XYZ123')).toBeNull();
    expect(normalizeHex('123')).toBeNull();
    expect(normalizeHex('1234567')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });
});

describe('transformSpoolmanDbFilament — single-color', () => {
  it('PLA Basic Red → 1 input, solid pattern, [#FF0000]', () => {
    const file = loadBambu();
    const plaBasic = file.filaments[0]!;
    const inputs = transformSpoolmanDbFilament(file, plaBasic, CTX, ACTOR);
    expect(inputs).toHaveLength(3); // Red, Black, Green
    const red = inputs[0]!;
    expect(red.brand).toBe('Bambu Lab');
    expect(red.subtype).toBe('PLA');
    expect(red.colorPattern).toBe('solid');
    expect(red.colors).toEqual(['#FF0000']);
    expect(red.colorName).toBe('Red');
    expect(red.source).toBe('system:spoolmandb');
    expect(red.ownerId).toBeNull();
    expect(red.actorRole).toBe('admin');
  });

  it('preserves filament-level fields (temps, density, weights, diameter)', () => {
    const file = loadBambu();
    const plaBasic = file.filaments[0]!;
    const [red] = transformSpoolmanDbFilament(file, plaBasic, CTX, ACTOR);
    expect(red!.density).toBe(1.24);
    expect(red!.diameterMm).toBe(1.75);
    expect(red!.spoolWeightG).toBe(1000);
    expect(red!.emptySpoolWeightG).toBe(250);
    expect(red!.defaultTemps).toEqual({
      nozzle_min: 220,
      nozzle_max: 220,
      bed: 60,
    });
    expect(red!.finish).toBe('matte');
    expect(red!.sourceRef).toBe(`${CTX.commitSha}:filaments/Bambu.json`);
  });

  it('hex normalization: "00AE42" → "#00AE42" (uppercase + prefix)', () => {
    const file = loadBambu();
    const plaBasic = file.filaments[0]!;
    const inputs = transformSpoolmanDbFilament(file, plaBasic, CTX, ACTOR);
    const green = inputs.find((i) => i.colorName === 'Green')!;
    expect(green.colors).toEqual(['#00AE42']);
  });
});

describe('transformSpoolmanDbFilament — multi-color', () => {
  it('dual-tone (coaxial, 2 hexes): Velvet Eclipse', () => {
    const file = loadBambu();
    const plaSilk = file.filaments[1]!;
    const inputs = transformSpoolmanDbFilament(file, plaSilk, CTX, ACTOR);
    expect(inputs).toHaveLength(2);
    const velvet = inputs.find((i) => i.colorName === 'Velvet Eclipse')!;
    expect(velvet.colorPattern).toBe('dual-tone');
    expect(velvet.colors).toEqual(['#000000', '#A34342']);
    expect(velvet.subtype).toBe('PLA-Silk');
  });

  it('multi-section (longitudinal, 4 hexes): Rainbow Quad', () => {
    const file = loadBambu();
    const galaxy = file.filaments[2]!;
    const inputs = transformSpoolmanDbFilament(file, galaxy, CTX, ACTOR);
    expect(inputs).toHaveLength(1);
    const rainbow = inputs[0]!;
    expect(rainbow.colorPattern).toBe('multi-section');
    expect(rainbow.colors).toEqual(['#FF0000', '#00AE42', '#0066FF', '#FFFF00']);
  });

  it('gradient (longitudinal, 2 hexes): synthetic case', () => {
    const file: SpoolmanDbBrandFile = {
      manufacturer: 'TestCo',
      filaments: [
        {
          name: 'Sunset',
          material: 'PLA',
          density: 1.24,
          multi_color_direction: 'longitudinal',
          colors: [{ name: 'Sunset', hexes: ['FF0000', 'FFFF00'] }],
        },
      ],
    };
    const inputs = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.colorPattern).toBe('gradient');
    expect(inputs[0]!.colors).toEqual(['#FF0000', '#FFFF00']);
  });

  it('gradient (longitudinal, 3 hexes): synthetic case', () => {
    const file: SpoolmanDbBrandFile = {
      manufacturer: 'TestCo',
      filaments: [
        {
          name: 'TriGrad',
          material: 'PLA',
          density: 1.24,
          multi_color_direction: 'longitudinal',
          colors: [{ name: 'Tri', hexes: ['FF0000', '00FF00', '0000FF'] }],
        },
      ],
    };
    const inputs = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.colorPattern).toBe('gradient');
    expect(inputs[0]!.colors).toEqual(['#FF0000', '#00FF00', '#0000FF']);
  });

  it('per-color override of multi_color_direction wins over filament-level', () => {
    const file: SpoolmanDbBrandFile = {
      manufacturer: 'TestCo',
      filaments: [
        {
          name: 'Mixed',
          material: 'PLA',
          density: 1.24,
          multi_color_direction: 'coaxial',
          colors: [
            { name: 'Coax', hexes: ['000000', 'FFFFFF'] },
            { name: 'Long', hexes: ['000000', 'FFFFFF'], multi_color_direction: 'longitudinal' },
          ],
        },
      ],
    };
    const inputs = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    expect(inputs).toHaveLength(2);
    const coax = inputs.find((i) => i.colorName === 'Coax')!;
    const long = inputs.find((i) => i.colorName === 'Long')!;
    expect(coax.colorPattern).toBe('dual-tone');
    expect(long.colorPattern).toBe('gradient');
  });
});

describe('transformSpoolmanDbFilament — id generation (idempotent slug)', () => {
  it('same inputs → same id', () => {
    const file = loadBambu();
    const a = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    const b = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
  });

  it('id pattern: system:spoolmandb:<brand>:<product>:<color>', () => {
    const id = buildFilamentProductId('Bambu Lab', 'PLA Basic', 'Red');
    expect(id).toBe('system:spoolmandb:bambu-lab:pla-basic:red');
  });

  it('different colors → different ids', () => {
    const file = loadBambu();
    const inputs = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    const ids = new Set(inputs.map((i) => i.id));
    expect(ids.size).toBe(inputs.length);
  });

  it('every emitted input carries an explicit id', () => {
    const file = loadBambu();
    for (const f of file.filaments) {
      const inputs = transformSpoolmanDbFilament(file, f, CTX, ACTOR);
      for (const inp of inputs) {
        expect(typeof inp.id).toBe('string');
        expect(inp.id!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('transformSpoolmanDbFilament — material→subtype edge cases', () => {
  it("'PLA Plus' → 'PLA+'", () => {
    const file: SpoolmanDbBrandFile = {
      manufacturer: 'TestCo',
      filaments: [
        {
          name: 'Plus',
          material: 'PLA Plus',
          density: 1.24,
          colors: [{ name: 'White', hex: 'FFFFFF' }],
        },
      ],
    };
    const inputs = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    expect(inputs[0]!.subtype).toBe('PLA+');
  });

  it("'Mystery Material' → 'other'", () => {
    const file: SpoolmanDbBrandFile = {
      manufacturer: 'TestCo',
      filaments: [
        {
          name: 'Mystery',
          material: 'Mystery Material',
          density: 1.24,
          colors: [{ name: 'Pink', hex: 'FF00FF' }],
        },
      ],
    };
    const inputs = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    expect(inputs[0]!.subtype).toBe('other');
  });

  it('drops a color with no usable hex', () => {
    const file: SpoolmanDbBrandFile = {
      manufacturer: 'TestCo',
      filaments: [
        {
          name: 'PartlyValid',
          material: 'PLA',
          density: 1.24,
          colors: [
            { name: 'Good', hex: 'FF0000' },
            { name: 'Bad' }, // no hex / no hexes
          ],
        },
      ],
    };
    const inputs = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.colorName).toBe('Good');
  });

  it('returns [] when filament has no colors array', () => {
    const file: SpoolmanDbBrandFile = {
      manufacturer: 'TestCo',
      filaments: [{ name: 'Empty', material: 'PLA', density: 1.24 }],
    };
    const inputs = transformSpoolmanDbFilament(file, file.filaments[0]!, CTX, ACTOR);
    expect(inputs).toEqual([]);
  });

  it('returns [] when manufacturer missing', () => {
    const broken = { filaments: [] } as unknown as SpoolmanDbBrandFile;
    const inputs = transformSpoolmanDbFilament(
      broken,
      { material: 'PLA', density: 1.24, colors: [{ name: 'X', hex: 'FFFFFF' }] },
      CTX,
      ACTOR,
    );
    expect(inputs).toEqual([]);
  });
});
