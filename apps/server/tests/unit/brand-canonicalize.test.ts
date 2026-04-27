/**
 * Unit tests — brand canonicalisation (V2-007b T_B5c).
 *
 * Pure-function tests + a small fs-touching test for `loadBrandAliases`.
 * No DB, no network.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  canonicalizeBrand,
  loadBrandAliases,
  type BrandAliases,
} from '../../src/scripts/_brand-canonicalize';

// ---------------------------------------------------------------------------
// canonicalizeBrand
// ---------------------------------------------------------------------------

describe('canonicalizeBrand', () => {
  const aliases: BrandAliases = {
    aliases: {
      'eSUN 3D': 'eSUN',
      Esun: 'eSUN',
      ESUN: 'eSUN',
      Bambu: 'Bambu Lab',
      BambuLab: 'Bambu Lab',
      PolyMaker: 'Polymaker',
      ELEGOO: 'Elegoo',
      ANYCUBIC: 'Anycubic',
      'Sun Lu': 'SUNLU',
    },
  };

  it('returns the mapped value on exact match', () => {
    expect(canonicalizeBrand('eSUN 3D', aliases)).toBe('eSUN');
    expect(canonicalizeBrand('Bambu', aliases)).toBe('Bambu Lab');
    expect(canonicalizeBrand('Sun Lu', aliases)).toBe('SUNLU');
  });

  it('falls back to a case-insensitive match', () => {
    expect(canonicalizeBrand('esun', aliases)).toBe('eSUN');
    expect(canonicalizeBrand('BAMBU', aliases)).toBe('Bambu Lab');
    expect(canonicalizeBrand('elegoo', aliases)).toBe('Elegoo');
    expect(canonicalizeBrand('anycubic', aliases)).toBe('Anycubic');
  });

  it('passes input through when there is no match', () => {
    expect(canonicalizeBrand('Prusa Polymers', aliases)).toBe('Prusa Polymers');
    expect(canonicalizeBrand('Some Brand', aliases)).toBe('Some Brand');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(canonicalizeBrand('  eSUN 3D  ', aliases)).toBe('eSUN');
    expect(canonicalizeBrand('\tBambu\n', aliases)).toBe('Bambu Lab');
    // Trim-only result also flows through when there is no match.
    expect(canonicalizeBrand('  Prusa Polymers ', aliases)).toBe('Prusa Polymers');
  });

  it('handles empty aliases (returns input unchanged)', () => {
    const empty: BrandAliases = { aliases: {} };
    expect(canonicalizeBrand('eSUN 3D', empty)).toBe('eSUN 3D');
    expect(canonicalizeBrand('  Bambu  ', empty)).toBe('Bambu');
  });
});

// ---------------------------------------------------------------------------
// loadBrandAliases
// ---------------------------------------------------------------------------

describe('loadBrandAliases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lootgoblin-brand-alias-'));
  });

  it('returns empty when the file is missing', async () => {
    const result = await loadBrandAliases(tmpDir);
    expect(result.aliases).toEqual({});
  });

  it('parses a valid aliases file', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'brand-aliases.json'),
      JSON.stringify({
        _note: 'whatever',
        aliases: {
          'eSUN 3D': 'eSUN',
          ESUN: 'eSUN',
          Bambu: 'Bambu Lab',
        },
      }),
    );
    const result = await loadBrandAliases(tmpDir);
    expect(result.aliases).toEqual({
      'eSUN 3D': 'eSUN',
      ESUN: 'eSUN',
      Bambu: 'Bambu Lab',
    });
  });

  it('returns empty when the file is malformed JSON', async () => {
    fs.writeFileSync(path.join(tmpDir, 'brand-aliases.json'), '{ not json }');
    const result = await loadBrandAliases(tmpDir);
    expect(result.aliases).toEqual({});
  });

  it('drops non-string alias entries', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'brand-aliases.json'),
      JSON.stringify({
        aliases: {
          good: 'Good',
          bad: 42,
          alsoBad: null,
        },
      }),
    );
    const result = await loadBrandAliases(tmpDir);
    expect(result.aliases).toEqual({ good: 'Good' });
  });
});
