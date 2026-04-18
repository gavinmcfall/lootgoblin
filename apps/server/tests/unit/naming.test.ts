import { describe, it, expect } from 'vitest';
import { expandTemplate, sanitizePathSegment } from '../../src/destinations/filesystem/naming';

describe('naming', () => {
  const ctx = {
    title: 'Elven Ranger: Bust v2',
    designer: 'Bulka Mancer',
    collection: 'Fantasy',
    category: 'Busts',
  };

  it('expands simple tokens', () => {
    expect(expandTemplate('{designer}/{title}', ctx)).toBe('Bulka Mancer/Elven Ranger- Bust v2');
  });

  it('handles optional collection token', () => {
    expect(expandTemplate('{designer}/{collection?}/{title}', ctx)).toBe('Bulka Mancer/Fantasy/Elven Ranger- Bust v2');
    expect(expandTemplate('{designer}/{collection?}/{title}', { ...ctx, collection: undefined })).toBe('Bulka Mancer/Elven Ranger- Bust v2');
  });

  it('sanitizes path segments', () => {
    expect(sanitizePathSegment('a/b?c<d>|e')).toBe('a-b-c-d-e');
    expect(sanitizePathSegment('  leading and trailing  ')).toBe('leading and trailing');
    expect(sanitizePathSegment('...')).toBe('_');
  });

  it('throws on unknown token', () => {
    expect(() => expandTemplate('{unknown}', ctx)).toThrow(/Unknown token/);
  });
});
