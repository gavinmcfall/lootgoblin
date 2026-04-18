import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/env';

describe('parseEnv', () => {
  it('rejects missing LOOTGOBLIN_SECRET', () => {
    expect(() => parseEnv({})).toThrow(/LOOTGOBLIN_SECRET/);
  });

  it('rejects LOOTGOBLIN_SECRET shorter than 32 bytes', () => {
    expect(() => parseEnv({ LOOTGOBLIN_SECRET: 'short' })).toThrow(/at least 32/);
  });

  it('accepts minimal valid env', () => {
    const env = parseEnv({ LOOTGOBLIN_SECRET: 'a'.repeat(32) });
    expect(env.PORT).toBe(7393);
    expect(env.DATABASE_URL).toBe('file:./lootgoblin.db');
    expect(env.AUTH_METHODS).toEqual(['forms']);
  });

  it('parses AUTH_METHODS csv', () => {
    const env = parseEnv({
      LOOTGOBLIN_SECRET: 'a'.repeat(32),
      AUTH_METHODS: 'forms,oidc',
      OIDC_ISSUER_URL: 'https://auth.example.com',
      OIDC_CLIENT_ID: 'lootgoblin',
      OIDC_CLIENT_SECRET: 'shh',
      OIDC_REDIRECT_URI: 'https://lootgoblin.example.com/api/auth/callback/oidc',
    });
    expect(env.AUTH_METHODS).toEqual(['forms', 'oidc']);
  });

  it('rejects none combined with forms', () => {
    expect(() =>
      parseEnv({ LOOTGOBLIN_SECRET: 'a'.repeat(32), AUTH_METHODS: 'forms,none' }),
    ).toThrow(/exclusive/);
  });

  it('rejects oidc without required OIDC env vars', () => {
    expect(() =>
      parseEnv({ LOOTGOBLIN_SECRET: 'a'.repeat(32), AUTH_METHODS: 'forms,oidc' }),
    ).toThrow(/OIDC_ISSUER_URL/);
  });
});
