/**
 * Unit tests for API key scope definitions — V2-001-T5
 *
 * Covers:
 *   - isValidScope() correctly identifies all 3 scopes + rejects unknowns.
 *   - Scope defaults: prefix, expiration days, and rate limit per scope.
 */

import { describe, it, expect } from 'vitest';
import { API_KEY_SCOPES, isValidScope } from '../../src/auth/scopes';

describe('isValidScope', () => {
  it('accepts extension_pairing', () => {
    expect(isValidScope('extension_pairing')).toBe(true);
  });

  it('accepts courier_pairing', () => {
    expect(isValidScope('courier_pairing')).toBe(true);
  });

  it('accepts programmatic', () => {
    expect(isValidScope('programmatic')).toBe(true);
  });

  it('rejects unknown scope string', () => {
    expect(isValidScope('admin')).toBe(false);
    expect(isValidScope('items:write')).toBe(false);
    expect(isValidScope('')).toBe(false);
    expect(isValidScope('EXTENSION_PAIRING')).toBe(false);
  });
});

describe('API_KEY_SCOPES defaults', () => {
  describe('extension_pairing', () => {
    const s = API_KEY_SCOPES.extension_pairing;

    it('has prefix lg_ext_', () => {
      expect(s.prefix).toBe('lg_ext_');
    });

    it('has defaultExpirationDays 365', () => {
      expect(s.defaultExpirationDays).toBe(365);
    });

    it('has rateLimitPerMinute 600', () => {
      expect(s.rateLimitPerMinute).toBe(600);
    });
  });

  describe('courier_pairing', () => {
    const s = API_KEY_SCOPES.courier_pairing;

    it('has prefix lg_cou_', () => {
      expect(s.prefix).toBe('lg_cou_');
    });

    it('has no expiration (null)', () => {
      expect(s.defaultExpirationDays).toBeNull();
    });

    it('has rateLimitPerMinute 1200', () => {
      expect(s.rateLimitPerMinute).toBe(1200);
    });
  });

  describe('programmatic', () => {
    const s = API_KEY_SCOPES.programmatic;

    it('has prefix lg_api_', () => {
      expect(s.prefix).toBe('lg_api_');
    });

    it('has defaultExpirationDays 90', () => {
      expect(s.defaultExpirationDays).toBe(90);
    });

    it('has rateLimitPerMinute 60', () => {
      expect(s.rateLimitPerMinute).toBe(60);
    });
  });

  it('all three scopes have a description', () => {
    for (const scope of Object.values(API_KEY_SCOPES)) {
      expect(typeof scope.description).toBe('string');
      expect(scope.description.length).toBeGreaterThan(0);
    }
  });
});
