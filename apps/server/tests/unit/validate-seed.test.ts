/**
 * Unit tests — validate-seed CLI (V2-007b T_B5c).
 *
 * No DB, no network. Builds a tmp seed root with synthetic files, runs the
 * validator, and asserts on the per-file reports.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runValidate,
  validateSeedFile,
  type ValidateOptions,
} from '../../src/scripts/validate-seed';

let tmpRoot: string;

function setupRoot(): void {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lootgoblin-validate-seed-'));
  fs.mkdirSync(path.join(tmpRoot, 'filaments'));
  fs.mkdirSync(path.join(tmpRoot, 'resins'));
}

function writeSeed(kind: 'filaments' | 'resins', name: string, body: unknown): string {
  const filePath = path.join(tmpRoot, kind, name);
  fs.writeFileSync(
    filePath,
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  );
  return filePath;
}

function baseOpts(overrides: Partial<ValidateOptions> = {}): ValidateOptions {
  return {
    seedRoot: tmpRoot,
    strict: false,
    filamentsOnly: false,
    resinsOnly: false,
    ...overrides,
  };
}

beforeEach(() => {
  setupRoot();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runValidate — happy path', () => {
  it('passes a clean resin seed file', () => {
    writeSeed('resins', 'example-co.json', {
      brand: 'Example Co',
      products: [
        {
          productLine: 'Test Tough',
          subtype: 'tough',
          colors: ['#FF6600'],
          colorName: 'Sunset Orange',
          defaultExposure: { layer_height_mm: 0.05, exposure_seconds: 7 },
          densityGMl: 1.13,
          materialClass: 'consumer',
          sourceRef: 'https://example.test/tough',
        },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(0);
    expect(out.reports[0]?.ok).toBe(true);
    expect(out.reports[0]?.entryCount).toBe(1);
  });

  it('passes a clean filament seed file', () => {
    writeSeed('filaments', 'example-fil.json', {
      brand: 'Example Fil',
      products: [
        {
          productLine: 'PLA Basic',
          subtype: 'PLA',
          colors: ['#FF0000'],
          colorPattern: 'solid',
          colorName: 'Red',
          sourceRef: 'https://example.test/pla',
        },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(0);
    expect(out.reports[0]?.entryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe('runValidate — failures', () => {
  it('rejects malformed JSON', () => {
    writeSeed('resins', 'broken.json', '{ bad json }');
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(1);
    const report = out.reports[0]!;
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.startsWith('malformed JSON:'))).toBe(true);
  });

  it('rejects missing required field (brand)', () => {
    writeSeed('resins', 'no-brand.json', {
      products: [
        { subtype: 'tough', colors: ['#FF0000'], sourceRef: 'https://x' },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(1);
    const report = out.reports[0]!;
    expect(report.errors.some((e) => e.startsWith('brand:'))).toBe(true);
  });

  it('rejects missing required field (subtype)', () => {
    writeSeed('resins', 'no-subtype.json', {
      brand: 'Example',
      products: [{ colors: ['#FF0000'], sourceRef: 'https://x' }],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(1);
    const report = out.reports[0]!;
    expect(report.errors.some((e) => e.includes('subtype'))).toBe(true);
  });

  it('rejects invalid hex', () => {
    writeSeed('resins', 'bad-hex.json', {
      brand: 'Example',
      products: [
        {
          subtype: 'tough',
          colors: ['not-a-hex'],
          sourceRef: 'https://x',
        },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(1);
    const report = out.reports[0]!;
    // Schema error path is products.0.colors.0; the error message references
    // either "hex" (custom message), the regex source, or path "colors".
    expect(
      report.errors.some((e) => /colors/.test(e) || /[0-9A-Fa-f]/.test(e)),
    ).toBe(true);
  });

  it('rejects duplicate id within a single file', () => {
    writeSeed('resins', 'dup-within.json', {
      brand: 'Example',
      products: [
        {
          id: 'system:community-pr:example:tough:red',
          subtype: 'tough',
          colors: ['#FF0000'],
          sourceRef: 'https://x',
        },
        {
          id: 'system:community-pr:example:tough:red',
          subtype: 'tough',
          colors: ['#FF0001'],
          sourceRef: 'https://x',
        },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(1);
    expect(
      out.reports[0]!.errors.some((e) => e.includes('duplicate id within file')),
    ).toBe(true);
  });

  it('rejects duplicate id across files of the same kind', () => {
    writeSeed('resins', 'a.json', {
      brand: 'Example A',
      products: [
        {
          id: 'system:community-pr:shared:tough:red',
          subtype: 'tough',
          colors: ['#FF0000'],
          sourceRef: 'https://x',
        },
      ],
    });
    writeSeed('resins', 'b.json', {
      brand: 'Example B',
      products: [
        {
          id: 'system:community-pr:shared:tough:red',
          subtype: 'tough',
          colors: ['#FF0001'],
          sourceRef: 'https://x',
        },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBeGreaterThanOrEqual(1);
    const messages = out.reports.flatMap((r) => r.errors).join('\n');
    expect(messages).toContain('also seen in');
  });

  it('rejects an invalid subtype enum value', () => {
    writeSeed('resins', 'bad-subtype.json', {
      brand: 'Example',
      products: [
        { subtype: 'totally-bogus', colors: ['#FF0000'], sourceRef: 'https://x' },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(1);
    expect(out.reports[0]!.errors.some((e) => e.includes('subtype'))).toBe(true);
  });

  it('rejects an invalid source enum value', () => {
    writeSeed('resins', 'bad-source.json', {
      brand: 'Example',
      products: [
        {
          subtype: 'tough',
          colors: ['#FF0000'],
          source: 'system:spoolmandb',
          sourceRef: 'https://x',
        },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(1);
    expect(
      out.reports[0]!.errors.some((e) => e.includes('source')),
    ).toBe(true);
  });

  it('rejects a filament with mismatched colorPattern length', () => {
    writeSeed('filaments', 'mismatch.json', {
      brand: 'Example',
      products: [
        {
          subtype: 'PLA',
          // dual-tone needs exactly 2 hexes; provide 1.
          colors: ['#FF0000'],
          colorPattern: 'dual-tone',
          sourceRef: 'https://x',
        },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.errorFiles).toBe(1);
    expect(
      out.reports[0]!.errors.some((e) => e.includes('colorPattern')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Strict mode
// ---------------------------------------------------------------------------

describe('runValidate — strict mode', () => {
  it('downgrades missing-sourceRef from warning to error in strict', () => {
    writeSeed('resins', 'no-sourceref.json', {
      brand: 'Example',
      products: [
        {
          subtype: 'tough',
          colors: ['#FF0000'],
          defaultExposure: { layer_height_mm: 0.05 },
        },
      ],
    });
    // Default — passes with a warning.
    const lax = runValidate(baseOpts());
    expect(lax.errorFiles).toBe(0);
    expect(lax.totalWarnings).toBeGreaterThan(0);

    // Strict — fails.
    const strict = runValidate(baseOpts({ strict: true }));
    expect(strict.errorFiles).toBe(1);
    expect(
      strict.reports[0]!.errors.some((e) => e.includes('missing sourceRef')),
    ).toBe(true);
  });

  it('flags missing defaultExposure as a warning (or strict error) for resin', () => {
    writeSeed('resins', 'no-exposure.json', {
      brand: 'Example',
      products: [
        {
          subtype: 'tough',
          colors: ['#FF0000'],
          sourceRef: 'https://x',
        },
      ],
    });
    const lax = runValidate(baseOpts());
    expect(lax.errorFiles).toBe(0);
    expect(lax.reports[0]!.warnings.some((w) => w.includes('defaultExposure'))).toBe(true);

    const strict = runValidate(baseOpts({ strict: true }));
    expect(strict.errorFiles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Filter flags
// ---------------------------------------------------------------------------

describe('runValidate — flags', () => {
  it('only validates filament files with --filaments-only', () => {
    writeSeed('filaments', 'fil.json', {
      brand: 'Fil Co',
      products: [
        {
          subtype: 'PLA',
          colors: ['#FF0000'],
          colorPattern: 'solid',
          sourceRef: 'https://x',
        },
      ],
    });
    writeSeed('resins', 'res.json', '{ broken }');
    const out = runValidate(baseOpts({ filamentsOnly: true }));
    expect(out.reports.length).toBe(1);
    expect(out.reports[0]!.fileName).toBe('fil.json');
  });

  it('only validates resin files with --resins-only', () => {
    writeSeed('filaments', 'fil.json', '{ broken }');
    writeSeed('resins', 'res.json', {
      brand: 'Res Co',
      products: [
        {
          subtype: 'tough',
          colors: ['#FF0000'],
          defaultExposure: { layer_height_mm: 0.05 },
          sourceRef: 'https://x',
        },
      ],
    });
    const out = runValidate(baseOpts({ resinsOnly: true }));
    expect(out.reports.length).toBe(1);
    expect(out.reports[0]!.fileName).toBe('res.json');
  });
});

// ---------------------------------------------------------------------------
// Underscore-prefixed files (skipped)
// ---------------------------------------------------------------------------

describe('runValidate — file filter', () => {
  it('skips files starting with underscore', () => {
    writeSeed('resins', '_index.json', { foo: 'bar' });
    writeSeed('resins', 'real.json', {
      brand: 'Real',
      products: [
        {
          subtype: 'tough',
          colors: ['#FF0000'],
          defaultExposure: { layer_height_mm: 0.05 },
          sourceRef: 'https://x',
        },
      ],
    });
    const out = runValidate(baseOpts());
    expect(out.reports.length).toBe(1);
    expect(out.reports[0]!.fileName).toBe('real.json');
  });
});

// ---------------------------------------------------------------------------
// Direct validateSeedFile coverage (path that can't see the directory walk).
// ---------------------------------------------------------------------------

describe('validateSeedFile (direct)', () => {
  it('reports read failure on a non-existent file', () => {
    const fake = path.join(tmpRoot, 'resins', 'nope.json');
    const report = validateSeedFile(fake, 'resin', { seenIds: new Map(), strict: false });
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/failed to read/);
  });
});
