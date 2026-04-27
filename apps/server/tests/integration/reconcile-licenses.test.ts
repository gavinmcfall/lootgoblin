/**
 * Integration test — reconcile-licenses CLI (V2-007b T_B5c).
 *
 * No DB, no network. Synthesises a tmp seed root + license file, runs the
 * reconciler, and asserts that the resin-seed block matches the seed
 * contents while leaving any spoolmandb block intact.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runReconcile,
  buildResinLicenseBlock,
  reconcileContent,
  collectResinBrandCitations,
  type ReconcileOptions,
} from '../../src/scripts/reconcile-licenses';

let tmpDir: string;
let seedRoot: string;
let licensePath: string;

function setup(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lootgoblin-reconcile-licenses-'));
  seedRoot = path.join(tmpDir, 'seed');
  licensePath = path.join(tmpDir, 'THIRD_PARTY_LICENSES.md');
  fs.mkdirSync(path.join(seedRoot, 'resins'), { recursive: true });
}

function writeResin(filename: string, body: unknown): void {
  fs.writeFileSync(path.join(seedRoot, 'resins', filename), JSON.stringify(body, null, 2));
}

function baseOpts(overrides: Partial<ReconcileOptions> = {}): ReconcileOptions {
  return {
    seedRoot,
    licensePath,
    check: false,
    ...overrides,
  };
}

beforeEach(() => {
  setup();
});

// ---------------------------------------------------------------------------
// collectResinBrandCitations
// ---------------------------------------------------------------------------

describe('collectResinBrandCitations', () => {
  it('returns brands sorted alphabetically with deduped source URLs', () => {
    writeResin('zeta.json', {
      brand: 'Zeta',
      products: [
        { subtype: 'tough', sourceRef: 'https://zeta.test/1' },
        { subtype: 'standard', sourceRef: 'https://zeta.test/1' }, // duplicate
        { subtype: 'standard', sourceRef: 'https://zeta.test/2' },
      ],
    });
    writeResin('alpha.json', {
      brand: 'Alpha',
      products: [{ subtype: 'tough', sourceRef: 'https://alpha.test/' }],
    });
    const out = collectResinBrandCitations(seedRoot);
    expect(out.map((c) => c.brand)).toEqual(['Alpha', 'Zeta']);
    // The dedupe happens in buildResinLicenseBlock; the collector preserves
    // the raw URL list so we can assert the count here.
    expect(out[1]?.sourceUrls).toEqual([
      'https://zeta.test/1',
      'https://zeta.test/1',
      'https://zeta.test/2',
    ]);
  });

  it('falls back to retailUrl when sourceRef is missing', () => {
    writeResin('a.json', {
      brand: 'A',
      products: [
        { subtype: 'tough', retailUrl: 'https://a.test/' },
      ],
    });
    const out = collectResinBrandCitations(seedRoot);
    expect(out[0]?.sourceUrls).toEqual(['https://a.test/']);
  });

  it('returns an empty list when the resins/ dir is missing', () => {
    fs.rmSync(path.join(seedRoot, 'resins'), { recursive: true, force: true });
    expect(collectResinBrandCitations(seedRoot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runReconcile — write mode (default)
// ---------------------------------------------------------------------------

describe('runReconcile — write mode', () => {
  it('creates a fresh THIRD_PARTY_LICENSES.md when none exists', () => {
    writeResin('alpha.json', {
      brand: 'Alpha',
      products: [{ subtype: 'tough', sourceRef: 'https://alpha.test/' }],
    });
    expect(fs.existsSync(licensePath)).toBe(false);
    const result = runReconcile(baseOpts());
    expect(result.changed).toBe(true);
    expect(fs.existsSync(licensePath)).toBe(true);
    const after = fs.readFileSync(licensePath, 'utf-8');
    expect(after).toContain('# Third-Party Licenses');
    expect(after).toContain('<!-- BEGIN resin-seed -->');
    expect(after).toContain('<!-- END resin-seed -->');
    expect(after).toContain('- Alpha: https://alpha.test/');
  });

  it('replaces an existing resin-seed block in place', () => {
    fs.writeFileSync(
      licensePath,
      `# Third-Party Licenses\n\n<!-- BEGIN resin-seed -->\nstale brand: stale-url\n<!-- END resin-seed -->\n`,
    );
    writeResin('newco.json', {
      brand: 'Newco',
      products: [{ subtype: 'tough', sourceRef: 'https://newco.test/' }],
    });
    const result = runReconcile(baseOpts());
    expect(result.changed).toBe(true);
    const after = fs.readFileSync(licensePath, 'utf-8');
    expect(after).not.toContain('stale brand: stale-url');
    expect(after).toContain('- Newco: https://newco.test/');
  });

  it('preserves the spoolmandb block when reconciling resin', () => {
    fs.writeFileSync(
      licensePath,
      [
        '# Third-Party Licenses',
        '',
        '<!-- BEGIN spoolmandb -->',
        '## SpoolmanDB',
        '- pinned commit abc123',
        '<!-- END spoolmandb -->',
        '',
      ].join('\n'),
    );
    writeResin('alpha.json', {
      brand: 'Alpha',
      products: [{ subtype: 'tough', sourceRef: 'https://alpha.test/' }],
    });
    const result = runReconcile(baseOpts());
    expect(result.changed).toBe(true);
    const after = fs.readFileSync(licensePath, 'utf-8');
    // Spoolmandb block survived.
    expect(after).toContain('<!-- BEGIN spoolmandb -->');
    expect(after).toContain('- pinned commit abc123');
    expect(after).toContain('<!-- END spoolmandb -->');
    // Resin block appended.
    expect(after).toContain('- Alpha: https://alpha.test/');
  });

  it('adds a brand that appears in seed but not yet in the license file', () => {
    fs.writeFileSync(
      licensePath,
      `# Third-Party Licenses\n\n<!-- BEGIN resin-seed -->\n- ExistingBrand: https://existing.test/\n<!-- END resin-seed -->\n`,
    );
    writeResin('existingbrand.json', {
      brand: 'ExistingBrand',
      products: [{ subtype: 'tough', sourceRef: 'https://existing.test/' }],
    });
    writeResin('newco.json', {
      brand: 'Newco',
      products: [{ subtype: 'tough', sourceRef: 'https://newco.test/' }],
    });
    const result = runReconcile(baseOpts());
    expect(result.changed).toBe(true);
    const after = fs.readFileSync(licensePath, 'utf-8');
    expect(after).toContain('- ExistingBrand: https://existing.test/');
    expect(after).toContain('- Newco: https://newco.test/');
  });

  it('returns changed=false on a re-run with no drift', () => {
    writeResin('alpha.json', {
      brand: 'Alpha',
      products: [{ subtype: 'tough', sourceRef: 'https://alpha.test/' }],
    });
    runReconcile(baseOpts());
    const second = runReconcile(baseOpts());
    expect(second.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runReconcile — check mode
// ---------------------------------------------------------------------------

describe('runReconcile — check mode', () => {
  it('reports changed=true (and does NOT write) when license file is out of sync', () => {
    fs.writeFileSync(
      licensePath,
      `# Third-Party Licenses\n\n<!-- BEGIN resin-seed -->\n(stale)\n<!-- END resin-seed -->\n`,
    );
    writeResin('alpha.json', {
      brand: 'Alpha',
      products: [{ subtype: 'tough', sourceRef: 'https://alpha.test/' }],
    });
    const before = fs.readFileSync(licensePath, 'utf-8');
    const result = runReconcile(baseOpts({ check: true }));
    expect(result.changed).toBe(true);
    // The file must NOT have been mutated in --check mode.
    const after = fs.readFileSync(licensePath, 'utf-8');
    expect(after).toBe(before);
  });

  it('reports changed=false when in sync', () => {
    writeResin('alpha.json', {
      brand: 'Alpha',
      products: [{ subtype: 'tough', sourceRef: 'https://alpha.test/' }],
    });
    runReconcile(baseOpts());
    const result = runReconcile(baseOpts({ check: true }));
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

describe('buildResinLicenseBlock', () => {
  it('renders a single-URL brand on one line', () => {
    const out = buildResinLicenseBlock([{ brand: 'A', sourceUrls: ['https://a.test/'] }]);
    expect(out).toContain('- A: https://a.test/');
  });

  it('renders multi-URL brand as nested list', () => {
    const out = buildResinLicenseBlock([
      { brand: 'A', sourceUrls: ['https://a.test/1', 'https://a.test/2'] },
    ]);
    expect(out).toContain('- A:\n');
    expect(out).toContain('  - https://a.test/1');
    expect(out).toContain('  - https://a.test/2');
  });

  it('handles a brand with no source URLs', () => {
    const out = buildResinLicenseBlock([{ brand: 'A', sourceUrls: [] }]);
    expect(out).toContain('- A: (no public source URLs cited)');
  });
});

describe('reconcileContent', () => {
  it('builds a fresh file when existing is null', () => {
    const out = reconcileContent(null, [{ brand: 'A', sourceUrls: ['https://a.test/'] }]);
    expect(out).toContain('# Third-Party Licenses');
    expect(out).toContain('- A: https://a.test/');
  });
});
