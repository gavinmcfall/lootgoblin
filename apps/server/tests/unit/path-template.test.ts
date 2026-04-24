/**
 * Unit tests for the path template engine — V2-002-T2
 *
 * Covers: parser, transforms, static validation, runtime resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  parseTemplate,
  validateTemplate,
  resolveTemplate,
  __transforms,
} from '../../src/stash/path-template';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('parseTemplate — parser', () => {
  it('parses {title|slug} → one segment with one field with one transform', () => {
    const pt = parseTemplate('{title|slug}');
    expect(pt.raw).toBe('{title|slug}');
    expect(pt.segments).toHaveLength(1);
    const seg = pt.segments[0];
    expect(seg).toHaveLength(1);
    const part = seg[0];
    expect(part.kind).toBe('field');
    if (part.kind === 'field') {
      expect(part.field.name).toBe('title');
      expect(part.field.transforms).toEqual(['slug']);
    }
  });

  it('parses {creator|slug}/{title|slug} → two segments, each with one field', () => {
    const pt = parseTemplate('{creator|slug}/{title|slug}');
    expect(pt.segments).toHaveLength(2);
    const [s0, s1] = pt.segments;
    expect(s0).toHaveLength(1);
    expect(s1).toHaveLength(1);
    expect(s0[0].kind).toBe('field');
    expect(s1[0].kind).toBe('field');
    if (s0[0].kind === 'field') expect(s0[0].field.name).toBe('creator');
    if (s1[0].kind === 'field') expect(s1[0].field.name).toBe('title');
  });

  it('parses literal foo/{title}/bar → three segments: literal, field, literal', () => {
    const pt = parseTemplate('foo/{title}/bar');
    expect(pt.segments).toHaveLength(3);
    expect(pt.segments[0][0]).toEqual({ kind: 'literal', value: 'foo' });
    expect(pt.segments[1][0].kind).toBe('field');
    if (pt.segments[1][0].kind === 'field') {
      expect(pt.segments[1][0].field.name).toBe('title');
      expect(pt.segments[1][0].field.transforms).toEqual([]);
    }
    expect(pt.segments[2][0]).toEqual({ kind: 'literal', value: 'bar' });
  });

  it('parses {title|truncate:60} → transform "truncate:60"', () => {
    const pt = parseTemplate('{title|truncate:60}');
    const part = pt.segments[0][0];
    expect(part.kind).toBe('field');
    if (part.kind === 'field') {
      expect(part.field.transforms).toEqual(['truncate:60']);
    }
  });

  it('parses {title|slug|truncate:60} → two transforms applied in order', () => {
    const pt = parseTemplate('{title|slug|truncate:60}');
    const part = pt.segments[0][0];
    expect(part.kind).toBe('field');
    if (part.kind === 'field') {
      expect(part.field.transforms).toEqual(['slug', 'truncate:60']);
    }
  });

  it('rejects unbalanced brace — missing close: {title', () => {
    expect(() => parseTemplate('{title')).toThrow();
  });

  it('rejects unbalanced brace — stray close: title}', () => {
    expect(() => parseTemplate('title}')).toThrow();
  });

  it('rejects double-open brace: {{title}}', () => {
    expect(() => parseTemplate('{{title}}')).toThrow();
  });

  it('rejects empty field {}', () => {
    expect(() => parseTemplate('{}')).toThrow();
  });

  it('rejects empty path (empty string)', () => {
    expect(() => parseTemplate('')).toThrow();
  });

  it('rejects trailing slash', () => {
    expect(() => parseTemplate('{title}/')).toThrow();
  });

  it('rejects leading slash', () => {
    expect(() => parseTemplate('/{title}')).toThrow();
  });

  it('rejects double slash', () => {
    expect(() => parseTemplate('{creator}//{title}')).toThrow();
  });

  it('rejects truncate:0 at parse time', () => {
    expect(() => parseTemplate('{title|truncate:0}')).toThrow();
  });

  it('rejects truncate:-5 at parse time', () => {
    expect(() => parseTemplate('{title|truncate:-5}')).toThrow();
  });

  it('rejects truncate:abc at parse time', () => {
    expect(() => parseTemplate('{title|truncate:abc}')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Transforms (via __transforms)
// ---------------------------------------------------------------------------

describe('transforms', () => {
  it('slug converts "Hello, World!" → "hello-world"', () => {
    expect(__transforms.slug('Hello, World!')).toBe('hello-world');
  });

  it('slug converts "  foo   bar  " → "foo-bar"', () => {
    expect(__transforms.slug('  foo   bar  ')).toBe('foo-bar');
  });

  it('slug converts "" → "" (not an error at transform time)', () => {
    expect(__transforms.slug('')).toBe('');
  });

  it('slug transliterates "Café" → "cafe"', () => {
    expect(__transforms.slug('Café')).toBe('cafe');
  });

  it('truncate:5 converts "abcdefgh" → "abcde"', () => {
    expect(__transforms['truncate:5']('abcdefgh')).toBe('abcde');
  });

  it('truncate:5 on "🔥🔥🔥🔥🔥🔥" produces first 5 code points', () => {
    const result = __transforms['truncate:5']('🔥🔥🔥🔥🔥🔥');
    // Each 🔥 is one code point; result should be exactly 5 fire emojis
    const codePoints = [...result];
    expect(codePoints).toHaveLength(5);
    expect(result).toBe('🔥🔥🔥🔥🔥');
  });

  it('sanitize converts "bad:name?.txt" → "bad_name_.txt"', () => {
    expect(__transforms.sanitize('bad:name?.txt')).toBe('bad_name_.txt');
  });

  it('multi-transform |slug|truncate:5 on "Hello World" → "hello"', () => {
    const afterSlug = __transforms.slug('Hello World');
    expect(afterSlug).toBe('hello-world');
    const afterTruncate = __transforms['truncate:5'](afterSlug);
    expect(afterTruncate).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// Validation (static, no resolve)
// ---------------------------------------------------------------------------

describe('validateTemplate — static validation', () => {
  it('flags reserved-name literal CON/{title} on windows', () => {
    const pt = parseTemplate('CON/{title}');
    const result = validateTemplate(pt, 'windows');
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('reserved-name');
  });

  it('CON/{title} is OK on linux', () => {
    const pt = parseTemplate('CON/{title}');
    expect(validateTemplate(pt, 'linux')).toBeNull();
  });

  it('CON/{title} is OK on macos', () => {
    const pt = parseTemplate('CON/{title}');
    expect(validateTemplate(pt, 'macos')).toBeNull();
  });

  it('flags forbidden-character ? in literal on windows', () => {
    const pt = parseTemplate('bad?name/{title}');
    const result = validateTemplate(pt, 'windows');
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('forbidden-character');
  });

  it('flags forbidden-character : on macos', () => {
    const pt = parseTemplate('bad:name/{title}');
    const result = validateTemplate(pt, 'macos');
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('forbidden-character');
  });

  it('flags forbidden-character : on windows', () => {
    const pt = parseTemplate('bad:name/{title}');
    const result = validateTemplate(pt, 'windows');
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('forbidden-character');
  });

  it('literal with : is OK on linux', () => {
    const pt = parseTemplate('bad:name/{title}');
    expect(validateTemplate(pt, 'linux')).toBeNull();
  });

  it('flags unknown-transform for {title|unknown-transform}', () => {
    const pt = parseTemplate('{title|unknown-transform}');
    const result = validateTemplate(pt, 'linux');
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('unknown-transform');
  });

  it('template with no literals and all valid fields validates fine', () => {
    const pt = parseTemplate('{creator|slug}/{title|slug}');
    expect(validateTemplate(pt, 'linux')).toBeNull();
    expect(validateTemplate(pt, 'macos')).toBeNull();
    expect(validateTemplate(pt, 'windows')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('resolveTemplate — resolution', () => {
  it('resolves {creator|slug}/{title|slug} on linux', () => {
    const pt = parseTemplate('{creator|slug}/{title|slug}');
    const result = resolveTemplate(pt, {
      metadata: { creator: 'Bulka', title: 'Test Model' },
      targetOS: 'linux',
    });
    expect(result).toEqual({ ok: true, path: 'bulka/test-model' });
  });

  it('returns missing-field when creator is absent', () => {
    const pt = parseTemplate('{creator|slug}');
    const result = resolveTemplate(pt, {
      metadata: {},
      targetOS: 'linux',
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing-field',
    });
    if (!result.ok) {
      expect(result.details).toMatch(/creator/);
    }
  });

  it('returns empty-segment when slug produces empty string', () => {
    const pt = parseTemplate('{creator|slug}');
    const result = resolveTemplate(pt, {
      metadata: { creator: '???' },
      targetOS: 'linux',
    });
    expect(result).toMatchObject({ ok: false, reason: 'empty-segment' });
  });

  it('returns reserved-name for {title|slug} with title: "NUL" on windows', () => {
    const pt = parseTemplate('{title|slug}');
    const result = resolveTemplate(pt, {
      metadata: { title: 'NUL' },
      targetOS: 'windows',
    });
    expect(result).toMatchObject({ ok: false, reason: 'reserved-name' });
  });

  it('returns reserved-name for {title} with title: "con.txt" on windows', () => {
    const pt = parseTemplate('{title}');
    const result = resolveTemplate(pt, {
      metadata: { title: 'con.txt' },
      targetOS: 'windows',
    });
    expect(result).toMatchObject({ ok: false, reason: 'reserved-name' });
  });

  it('returns segment-too-long when segment exceeds 255 bytes', () => {
    const pt = parseTemplate('{title}');
    const result = resolveTemplate(pt, {
      metadata: { title: 'a'.repeat(500) },
      targetOS: 'linux',
    });
    expect(result).toMatchObject({ ok: false, reason: 'segment-too-long' });
  });

  it('returns path-too-long when two segments together exceed 260 on windows', () => {
    const pt = parseTemplate('{creator}/{title}');
    const result = resolveTemplate(pt, {
      // 130 chars each, combined "creator/title" = 261 chars > 260
      metadata: { creator: 'a'.repeat(130), title: 'b'.repeat(130) },
      targetOS: 'windows',
    });
    expect(result).toMatchObject({ ok: false, reason: 'path-too-long' });
  });

  it('coerces array tags via join before slug: {tags|slug} with tags: ["3d","model"] → "3d-model"', () => {
    const pt = parseTemplate('{tags|slug}');
    const result = resolveTemplate(pt, {
      metadata: { tags: ['3d', 'model'] },
      targetOS: 'linux',
    });
    expect(result).toEqual({ ok: true, path: '3d-model' });
  });

  it('returns missing-field for null metadata value', () => {
    const pt = parseTemplate('{creator|slug}');
    const result = resolveTemplate(pt, {
      metadata: { creator: null },
      targetOS: 'linux',
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing-field' });
  });
});
