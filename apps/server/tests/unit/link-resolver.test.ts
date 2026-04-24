/**
 * Unit tests for link-resolver.ts
 *
 * Pure function tests — no FS, DB, or HTTP. Covers resolve() and scan().
 */

import { describe, it, expect } from 'vitest';
import { createLinkResolver } from '../../src/scavengers/link-resolver';
import type { LinkResolution } from '../../src/scavengers/link-resolver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function known(resolution: LinkResolution) {
  expect(resolution.kind).toBe('known');
  return resolution as Extract<LinkResolution, { kind: 'known' }>;
}

function unknown(resolution: LinkResolution) {
  expect(resolution.kind).toBe('unknown');
  return resolution as Extract<LinkResolution, { kind: 'unknown' }>;
}

// ---------------------------------------------------------------------------
// resolve() — per-source URL patterns
// ---------------------------------------------------------------------------

describe('LinkResolver.resolve()', () => {
  const resolver = createLinkResolver();

  // 1. GDrive file URL
  it('GDrive file URL — sourceId=google-drive, context.kind=file, id extracted', () => {
    const r = known(resolver.resolve('https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs/view?usp=sharing'));
    expect(r.sourceId).toBe('google-drive');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs');
  });

  // 2. GDrive folder URL
  it('GDrive folder URL — context.kind=folder, id extracted', () => {
    const r = known(resolver.resolve('https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsTuV'));
    expect(r.sourceId).toBe('google-drive');
    expect(r.context?.kind).toBe('folder');
    expect(r.context?.id).toBe('1aBcDeFgHiJkLmNoPqRsTuV');
  });

  // 3. GDrive URL with u/0/ segment
  it('GDrive folder URL with u/0/ segment — same id extracted', () => {
    const r = known(resolver.resolve('https://drive.google.com/drive/u/0/folders/1aBcDeFgHiJkLmNoPqRsTuV'));
    expect(r.sourceId).toBe('google-drive');
    expect(r.context?.kind).toBe('folder');
    expect(r.context?.id).toBe('1aBcDeFgHiJkLmNoPqRsTuV');
  });

  // 4. GDrive /open?id=X
  it('GDrive /open?id=X URL — context.kind=open, id extracted', () => {
    const r = known(resolver.resolve('https://drive.google.com/open?id=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs'));
    expect(r.sourceId).toBe('google-drive');
    expect(r.context?.kind).toBe('open');
    expect(r.context?.id).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs');
  });

  // 5. GDrive URL with resourcekey= param
  it('GDrive URL with resourcekey= — resourceKey populated', () => {
    const r = known(
      resolver.resolve(
        'https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs/view?resourcekey=0-abcdefghijklmnop',
      ),
    );
    expect(r.sourceId).toBe('google-drive');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs');
    expect(r.context?.resourceKey).toBe('0-abcdefghijklmnop');
    // resourcekey must survive normalisation
    expect(r.normalizedUrl).toContain('resourcekey=0-abcdefghijklmnop');
  });

  // 6. MEGA folder — kind='folder', fragment populated
  it('MEGA folder URL — sourceId=mega, context.kind=folder, fragment populated', () => {
    const r = known(resolver.resolve('https://mega.nz/folder/AbCdEfGh#keypart123'));
    expect(r.sourceId).toBe('mega');
    expect(r.context?.kind).toBe('folder');
    expect(r.context?.id).toBe('AbCdEfGh');
    expect(r.context?.fragment).toBe('#keypart123');
  });

  // 7. MEGA file — kind='file', fragment populated
  it('MEGA file URL — sourceId=mega, context.kind=file, fragment populated', () => {
    const r = known(resolver.resolve('https://mega.nz/file/XyZ12345#decryptionKey'));
    expect(r.sourceId).toBe('mega');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe('XyZ12345');
    expect(r.context?.fragment).toBe('#decryptionKey');
  });

  // 8. MEGA legacy #F!… format — kind='folder', fragment
  it('MEGA legacy #F!… URL — sourceId=mega, context.kind=folder, fragment', () => {
    const r = known(resolver.resolve('https://mega.nz/#F!abc123!keypart'));
    expect(r.sourceId).toBe('mega');
    expect(r.context?.kind).toBe('folder');
    expect(r.context?.fragment).toContain('F!');
  });

  // 9. Cults3D URL
  it('Cults3D URL — sourceId=cults3d, id=slug', () => {
    const r = known(resolver.resolve('https://cults3d.com/en/3d-model/cool-castle'));
    expect(r.sourceId).toBe('cults3d');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe('cool-castle');
  });

  // 10. Thingiverse URL
  it('Thingiverse URL — sourceId=thingiverse, id=numericId', () => {
    const r = known(resolver.resolve('https://www.thingiverse.com/thing:12345'));
    expect(r.sourceId).toBe('thingiverse');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe('12345');
  });

  // 11. Printables URL
  it('Printables URL — sourceId=printables, id=numericId', () => {
    const r = known(resolver.resolve('https://www.printables.com/model/98765-cool-model'));
    expect(r.sourceId).toBe('printables');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe('98765');
  });

  // 12. MakerWorld URL
  it('MakerWorld URL — sourceId=makerworld, id=numericId', () => {
    const r = known(resolver.resolve('https://makerworld.com/en/models/54321'));
    expect(r.sourceId).toBe('makerworld');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe('54321');
  });

  // 13. Sketchfab URL
  it('Sketchfab URL — sourceId=sketchfab, id=uid (32-char hex)', () => {
    const uid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const r = known(resolver.resolve(`https://sketchfab.com/3d-models/cool-model-${uid}`));
    expect(r.sourceId).toBe('sketchfab');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe(uid);
  });

  // 14. Patreon post URL
  it('Patreon post URL — sourceId=patreon, id=numericId', () => {
    const r = known(resolver.resolve('https://www.patreon.com/posts/cool-thing-67890'));
    expect(r.sourceId).toBe('patreon');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe('67890');
  });

  // 15. Unknown URL
  it('Unknown URL (github.com) — kind=unknown, rawUrl preserved', () => {
    const url = 'https://github.com/someone/something';
    const r = unknown(resolver.resolve(url));
    expect(r.rawUrl).toBe(url);
  });

  // 16. Normalisation: trailing slash stripped
  it('Normalisation: trailing slash stripped from pathname', () => {
    const r = known(resolver.resolve('https://www.printables.com/model/98765-cool-model/'));
    expect(r.normalizedUrl).not.toMatch(/\/$/);
  });

  // 17. Normalisation: utm_source stripped
  it('Normalisation: utm_source tracking param stripped', () => {
    const r = known(
      resolver.resolve('https://cults3d.com/en/3d-model/cool-castle?utm_source=patreon&utm_campaign=launch'),
    );
    expect(r.normalizedUrl).not.toContain('utm_source');
    expect(r.normalizedUrl).not.toContain('utm_campaign');
    expect(r.normalizedUrl).toContain('cults3d.com');
  });

  // 18. Normalisation: hostname lowercased
  it('Normalisation: hostname lowercased', () => {
    const r = known(resolver.resolve('https://WWW.THINGIVERSE.COM/thing:12345'));
    expect(r.normalizedUrl).toMatch(/^https:\/\/www\.thingiverse\.com/);
  });
});

// ---------------------------------------------------------------------------
// resolve() — additional edge cases
// ---------------------------------------------------------------------------

describe('LinkResolver.resolve() — edge cases', () => {
  const resolver = createLinkResolver();

  it('Thingiverse URL with /files suffix — same thing id', () => {
    const r = known(resolver.resolve('https://www.thingiverse.com/thing:12345/files'));
    expect(r.sourceId).toBe('thingiverse');
    expect(r.context?.id).toBe('12345');
  });

  it('Printables URL with locale prefix (/de/model/…) — id extracted', () => {
    const r = known(resolver.resolve('https://www.printables.com/de/model/98765-cool-model'));
    expect(r.sourceId).toBe('printables');
    expect(r.context?.id).toBe('98765');
  });

  it('MakerWorld URL with non-en locale — id extracted', () => {
    const r = known(resolver.resolve('https://makerworld.com/de/models/54321'));
    expect(r.sourceId).toBe('makerworld');
    expect(r.context?.id).toBe('54321');
  });

  it('Cults3D URL with non-en locale — id extracted', () => {
    const r = known(resolver.resolve('https://cults3d.com/fr/3d-model/chaise-cool'));
    expect(r.sourceId).toBe('cults3d');
    expect(r.context?.id).toBe('chaise-cool');
  });

  it('Sketchfab /models/{uid} direct format — id=uid', () => {
    const uid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const r = known(resolver.resolve(`https://sketchfab.com/models/${uid}`));
    expect(r.sourceId).toBe('sketchfab');
    expect(r.context?.id).toBe(uid);
  });

  it('GDrive docs.google.com URL — sourceId=google-drive, kind=file', () => {
    const r = known(
      resolver.resolve('https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs/edit'),
    );
    expect(r.sourceId).toBe('google-drive');
    expect(r.context?.kind).toBe('file');
    expect(r.context?.id).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs');
  });

  it('Malformed URL — kind=unknown', () => {
    const r = unknown(resolver.resolve('not-a-url'));
    expect(r.rawUrl).toBe('not-a-url');
  });
});

// ---------------------------------------------------------------------------
// scan() — text blob extraction
// ---------------------------------------------------------------------------

describe('LinkResolver.scan()', () => {
  const resolver = createLinkResolver();

  // 19. Extract 3 URLs from a text blob
  it('Extract 3 URLs from a text blob mixing known and unknown sources', () => {
    const text = `
      Check out this model: https://cults3d.com/en/3d-model/foo
      Also on Thingiverse: https://www.thingiverse.com/thing:123
      And some random link: https://github.com/someone/something
    `;
    const results = resolver.scan(text);
    expect(results).toHaveLength(3);
    expect(results[0].kind).toBe('known');
    expect(results[1].kind).toBe('known');
    expect(results[2].kind).toBe('unknown');
  });

  // 20. Deduplicate: same URL twice → one result
  it('Deduplicate: same URL appearing twice yields one result', () => {
    const url = 'https://www.printables.com/model/98765-cool-model';
    const text = `See ${url} and also ${url}`;
    const results = resolver.scan(text);
    expect(results).toHaveLength(1);
  });

  // 21. Order preservation: URLs returned in first-appearance order
  it('Order preservation: URLs returned in first-appearance order', () => {
    const text = `
      First: https://cults3d.com/en/3d-model/foo
      Second: https://www.thingiverse.com/thing:123
      Third: https://makerworld.com/en/models/54321
    `;
    const results = resolver.scan(text);
    expect(results).toHaveLength(3);
    const knowns = results.filter((r) => r.kind === 'known') as Extract<LinkResolution, { kind: 'known' }>[];
    expect(knowns[0].sourceId).toBe('cults3d');
    expect(knowns[1].sourceId).toBe('thingiverse');
    expect(knowns[2].sourceId).toBe('makerworld');
  });

  // 22. Empty text → []
  it('Empty text — returns empty array', () => {
    expect(resolver.scan('')).toEqual([]);
  });

  // 23. Text with no URLs → []
  it('Text with no URLs — returns empty array', () => {
    expect(resolver.scan('No links here, just plain text.')).toEqual([]);
  });

  // 24. URLs mixed with punctuation and Markdown syntax
  it('URLs in Markdown syntax extracted correctly', () => {
    const text =
      'Check out [this model](https://cults3d.com/en/3d-model/foo) and https://www.thingiverse.com/thing:123.';
    const results = resolver.scan(text);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.kind === 'known')).toBe(true);
    const knowns = results as Extract<LinkResolution, { kind: 'known' }>[];
    expect(knowns[0].sourceId).toBe('cults3d');
    expect(knowns[1].sourceId).toBe('thingiverse');
  });
});
