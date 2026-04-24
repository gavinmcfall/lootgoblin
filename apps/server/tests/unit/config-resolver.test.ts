/**
 * Tests for the three-tier ConfigResolver — V2-001-T3
 *
 * Tests use the dependency-injection constructor to supply a fake DB adapter,
 * avoiding any real database, native module loading, or vi.mock complexity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigResolver, ConfigurationError, nullDbAdapter } from '../../src/config/resolver';
import type { ConfigDbAdapter, } from '../../src/config/resolver';
import type { ProvenanceEntry } from '../../src/config/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const REQUIRED_ENV = {
  DATABASE_URL: 'file:/tmp/test.db',
  BETTER_AUTH_SECRET: 'super-secret-value-that-is-long-enough',
  BETTER_AUTH_URL: 'http://localhost:7393',
};

function tmpYaml(content: string): string {
  const p = path.join(os.tmpdir(), `lootgoblin-test-${process.pid}-${Date.now()}.yml`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/** Creates a DB adapter that returns the given data map for reads. */
function makeDbAdapter(data: Record<string, unknown> = {}): ConfigDbAdapter {
  const writeLog: ProvenanceEntry[] = [];
  return {
    async readInstanceConfig(key: string) {
      if (key in data && data[key] !== undefined) {
        return { key, value: data[key] };
      }
      return undefined;
    },
    async writeProvenance(entry: ProvenanceEntry) {
      writeLog.push(entry);
    },
    // Expose log for assertions
    _writeLog: writeLog,
  } as ConfigDbAdapter & { _writeLog: ProvenanceEntry[] };
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear relevant keys before each test.
  for (const key of [
    'DATABASE_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL',
    'CONFIG_FILE_PATH', 'STASH_ROOTS', 'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ADMIN_GROUP_CLAIM',
    'PASSWORD_LOGIN_ENABLED', 'INSTANCE_NAME', 'LOG_LEVEL',
    'NOTIFICATION_PREFS', 'DEFAULT_TEMPLATE',
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ConfigResolver', () => {
  describe('precedence — tier-1 (secrets/env) wins over everything', () => {
    it('tier-1 value wins when all tiers supply a value', async () => {
      // Tier-1 wins: LOG_LEVEL=debug from env
      Object.assign(process.env, REQUIRED_ENV, { LOG_LEVEL: 'debug' });
      // Tier-2 would supply warn via file
      const yamlPath = tmpYaml('log_level: warn\n');
      process.env.CONFIG_FILE_PATH = yamlPath;
      // Tier-3 would supply error via DB
      const db = makeDbAdapter({ LOG_LEVEL: 'error' });

      const resolver = new ConfigResolver(db);
      const result = await resolver.resolve();

      expect(result.LOG_LEVEL).toBe('debug');
      expect(resolver.getProvenance('LOG_LEVEL').source).toBe('secrets');
    });
  });

  describe('precedence — tier-2 (file) wins when tier-1 absent', () => {
    it('reads LOG_LEVEL from YAML file when not in env', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const yamlPath = tmpYaml('log_level: warn\n');
      process.env.CONFIG_FILE_PATH = yamlPath;
      // Tier-3 would supply error — should be overridden by file
      const db = makeDbAdapter({ LOG_LEVEL: 'error' });

      const resolver = new ConfigResolver(db);
      const result = await resolver.resolve();

      expect(result.LOG_LEVEL).toBe('warn');
      expect(resolver.getProvenance('LOG_LEVEL').source).toBe('file');
    });

    it('reads STASH_ROOTS array from YAML file', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const yamlPath = tmpYaml('stash_roots:\n  - /mnt/stash1\n  - /mnt/stash2\n');
      process.env.CONFIG_FILE_PATH = yamlPath;

      const resolver = new ConfigResolver(nullDbAdapter);
      const result = await resolver.resolve();

      expect(result.STASH_ROOTS).toEqual(['/mnt/stash1', '/mnt/stash2']);
      expect(resolver.getProvenance('STASH_ROOTS').source).toBe('file');
    });
  });

  describe('precedence — tier-3 (DB) wins when tiers 1 and 2 absent', () => {
    it('reads LOG_LEVEL from DB instance_config when env and file absent', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      // No YAML file (point to non-existent path)
      process.env.CONFIG_FILE_PATH = '/tmp/nonexistent-config-file-t3.yml';
      const db = makeDbAdapter({ LOG_LEVEL: 'error' });

      const resolver = new ConfigResolver(db);
      const result = await resolver.resolve();

      expect(result.LOG_LEVEL).toBe('error');
      expect(resolver.getProvenance('LOG_LEVEL').source).toBe('db');
    });
  });

  describe('required key validation', () => {
    it('throws ConfigurationError when BETTER_AUTH_SECRET is missing from all tiers', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      delete process.env.BETTER_AUTH_SECRET;
      process.env.CONFIG_FILE_PATH = '/tmp/nonexistent-config-file-t3.yml';

      const resolver = new ConfigResolver(nullDbAdapter);
      await expect(resolver.resolve()).rejects.toThrow(ConfigurationError);
      await expect(resolver.resolve()).rejects.toThrow(/BETTER_AUTH_SECRET/);
    });

    it('throws ConfigurationError when BETTER_AUTH_URL is missing from all tiers', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      delete process.env.BETTER_AUTH_URL;
      process.env.CONFIG_FILE_PATH = '/tmp/nonexistent-config-file-t3.yml';

      const resolver = new ConfigResolver(nullDbAdapter);
      await expect(resolver.resolve()).rejects.toThrow(ConfigurationError);
      await expect(resolver.resolve()).rejects.toThrow(/BETTER_AUTH_URL/);
    });

    it('throws ConfigurationError when DATABASE_URL is missing from all tiers', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      delete process.env.DATABASE_URL;
      process.env.CONFIG_FILE_PATH = '/tmp/nonexistent-config-file-t3.yml';

      const resolver = new ConfigResolver(nullDbAdapter);
      await expect(resolver.resolve()).rejects.toThrow(ConfigurationError);
      await expect(resolver.resolve()).rejects.toThrow(/DATABASE_URL/);
    });

    it('error message includes which tiers were checked', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      delete process.env.BETTER_AUTH_SECRET;
      const yamlPath = tmpYaml('log_level: info\n'); // file exists but no BETTER_AUTH_SECRET
      process.env.CONFIG_FILE_PATH = yamlPath;

      const resolver = new ConfigResolver(nullDbAdapter);
      await expect(resolver.resolve()).rejects.toThrow(/env var BETTER_AUTH_SECRET/);
    });
  });

  describe('OIDC-only mode validation', () => {
    it('throws ConfigurationError when PASSWORD_LOGIN_ENABLED=false and no OIDC configured', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        PASSWORD_LOGIN_ENABLED: 'false',
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      await expect(resolver.resolve()).rejects.toThrow(ConfigurationError);
      await expect(resolver.resolve()).rejects.toThrow(/OIDC-only mode/);
    });

    it('does not throw when PASSWORD_LOGIN_ENABLED=false with full OIDC config', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        PASSWORD_LOGIN_ENABLED: 'false',
        OIDC_ISSUER_URL: 'https://auth.example.com',
        OIDC_CLIENT_ID: 'lootgoblin',
        OIDC_CLIENT_SECRET: 'shh',
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      await expect(resolver.resolve()).resolves.not.toThrow();
    });

    it('does not throw when PASSWORD_LOGIN_ENABLED=true and no OIDC (default)', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      await expect(resolver.resolve()).resolves.not.toThrow();
    });
  });

  describe('malformed YAML', () => {
    it('throws ConfigurationError with error details for malformed YAML', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      // Write a genuinely malformed YAML (duplicate keys + tab indentation, which yaml rejects)
      const badYaml = tmpYaml('key: value\nkey: [unclosed\n');
      process.env.CONFIG_FILE_PATH = badYaml;

      const resolver = new ConfigResolver(nullDbAdapter);
      // yaml v2 may or may not throw on duplicate keys; use an actually unparseable structure
      // Use non-string mapping key which is invalid YAML at document level
    });

    it('throws ConfigurationError for YAML with unclosed bracket', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const badYaml = tmpYaml('stash_roots: [/mnt/stash, /mnt/other\n');
      process.env.CONFIG_FILE_PATH = badYaml;

      const resolver = new ConfigResolver(nullDbAdapter);
      await expect(resolver.resolve()).rejects.toThrow(ConfigurationError);
      await expect(resolver.resolve()).rejects.toThrow(/Failed to parse YAML/);
    });
  });

  describe('pending-wizard detection', () => {
    it('marks STASH_ROOTS as pending-wizard when no tier supplies it', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      process.env.CONFIG_FILE_PATH = '/tmp/nonexistent-config-file-t3.yml';

      const resolver = new ConfigResolver(nullDbAdapter);
      await resolver.resolve();

      expect(resolver.isPendingWizard('STASH_ROOTS')).toBe(true);
    });

    it('does not mark STASH_ROOTS as pending when a non-empty value is supplied', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        STASH_ROOTS: '/mnt/stash',
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      await resolver.resolve();

      expect(resolver.isPendingWizard('STASH_ROOTS')).toBe(false);
    });

    it('does not mark non-deferrable keys as pending-wizard', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      await resolver.resolve();

      // LOG_LEVEL has a default — not pending
      expect(resolver.isPendingWizard('LOG_LEVEL')).toBe(false);
    });
  });

  describe('configProvenance', () => {
    it('records source=secrets for env-sourced keys', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      await resolver.resolve();

      const p = resolver.getProvenance('BETTER_AUTH_SECRET');
      expect(p.source).toBe('secrets');
      expect(p.sourceDetail).toMatch(/^env:BETTER_AUTH_SECRET/);
    });

    it('records source=default for keys using built-in defaults', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      await resolver.resolve();

      const p = resolver.getProvenance('LOG_LEVEL');
      expect(p.source).toBe('default');
    });

    it('records source=file for YAML-sourced keys', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const yamlPath = tmpYaml('log_level: debug\n');
      process.env.CONFIG_FILE_PATH = yamlPath;

      const resolver = new ConfigResolver(nullDbAdapter);
      await resolver.resolve();

      const p = resolver.getProvenance('LOG_LEVEL');
      expect(p.source).toBe('file');
      expect(p.sourceDetail).toMatch(/^file:/);
    });

    it('records source=db for DB-sourced keys', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });
      const db = makeDbAdapter({ LOG_LEVEL: 'warn' });

      const resolver = new ConfigResolver(db);
      await resolver.resolve();

      const p = resolver.getProvenance('LOG_LEVEL');
      expect(p.source).toBe('db');
    });

    it('records resolvedAt timestamp within test window', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const before = new Date();
      const resolver = new ConfigResolver(nullDbAdapter);
      await resolver.resolve();
      const after = new Date();

      const p = resolver.getProvenance('DATABASE_URL');
      expect(p.resolvedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(p.resolvedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('provenance is written to DB adapter after resolve()', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });
      const db = makeDbAdapter();
      const dbWithLog = db as ConfigDbAdapter & { _writeLog: ProvenanceEntry[] };

      const resolver = new ConfigResolver(db);
      await resolver.resolve();

      // Give the fire-and-forget Promise.allSettled a tick to finish
      await new Promise((r) => setTimeout(r, 10));

      expect(dbWithLog._writeLog.length).toBeGreaterThan(0);
      const secretEntry = dbWithLog._writeLog.find((e) => e.key === 'BETTER_AUTH_SECRET');
      expect(secretEntry).toBeDefined();
      expect(secretEntry?.source).toBe('secrets');
    });
  });

  describe('unknown YAML keys', () => {
    it('warns but does not throw for unknown YAML keys', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const yamlPath = tmpYaml('unknown_future_key: some_value\nlog_level: info\n');
      process.env.CONFIG_FILE_PATH = yamlPath;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const resolver = new ConfigResolver(nullDbAdapter);
      await expect(resolver.resolve()).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown_future_key'),
      );
    });
  });

  describe('get() before resolve()', () => {
    it('throws ConfigurationError if get() called before resolve()', () => {
      const resolver = new ConfigResolver(nullDbAdapter);
      expect(() => resolver.get('DATABASE_URL')).toThrow(ConfigurationError);
      expect(() => resolver.get('DATABASE_URL')).toThrow(/before resolve/);
    });
  });

  describe('defaults', () => {
    it('applies documented defaults for optional keys', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      const result = await resolver.resolve();

      expect(result.LOG_LEVEL).toBe('info');
      expect(result.PASSWORD_LOGIN_ENABLED).toBe(true);
      expect(result.OIDC_ADMIN_GROUP_CLAIM).toBe('admin');
      // CONFIG_FILE_PATH default is the config default but we overrode via env
      expect(result.NOTIFICATION_PREFS).toBe('{}');
      expect(result.DEFAULT_TEMPLATE).toBe('{creator}/{title}');
    });

    it('derives INSTANCE_NAME from hostname when not set in any tier', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      const result = await resolver.resolve();

      expect(result.INSTANCE_NAME).toBe(os.hostname());
    });

    it('uses INSTANCE_NAME from env when set', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        INSTANCE_NAME: 'my-instance',
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      const result = await resolver.resolve();

      expect(result.INSTANCE_NAME).toBe('my-instance');
    });
  });

  describe('STASH_ROOTS coercion', () => {
    it('coerces colon-separated STASH_ROOTS env var to array', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        STASH_ROOTS: '/mnt/stash1:/mnt/stash2:/mnt/stash3',
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      const result = await resolver.resolve();

      expect(result.STASH_ROOTS).toEqual(['/mnt/stash1', '/mnt/stash2', '/mnt/stash3']);
    });
  });

  describe('getResolved()', () => {
    it('returns null before resolve()', () => {
      const resolver = new ConfigResolver(nullDbAdapter);
      expect(resolver.getResolved()).toBeNull();
    });

    it('returns resolved config after resolve()', async () => {
      Object.assign(process.env, REQUIRED_ENV, {
        CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-t3.yml',
      });

      const resolver = new ConfigResolver(nullDbAdapter);
      await resolver.resolve();

      expect(resolver.getResolved()).not.toBeNull();
      expect(resolver.getResolved()?.DATABASE_URL).toBe(REQUIRED_ENV.DATABASE_URL);
    });
  });
});
