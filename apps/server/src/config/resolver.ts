/**
 * Three-tier config resolver — V2-001-T3
 *
 * Resolution order per key (first non-null wins):
 *   1. Secrets tier   — process.env + mounted-secret files (K8s / Docker secrets)
 *   2. File tier      — YAML file at CONFIG_FILE_PATH (default /config/lootgoblin.yml)
 *   3. DB tier        — instance_config table (runtime-mutable / wizard-sourced)
 *   4. Default tier   — documented defaults in CONFIG_DEFAULTS
 *
 * Writes one row per key to config_provenance after each resolve() call.
 *
 * IMPORTANT: This module avoids importing from '@/…' aliases so it is
 * usable in contexts where tsconfig paths may not be resolved (e.g. direct
 * node execution, test harness without path mapping). Relative imports only.
 */

import fs from 'node:fs';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import type {
  ResolvedConfig,
  ProvenanceEntry,
  ConfigSource,
} from './types.js';
import {
  REQUIRED_BOOT_KEYS,
  WIZARD_DEFERRABLE_KEYS,
  CONFIG_DEFAULTS,
} from './types.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

// ---------------------------------------------------------------------------
// Environment-variable → config-key mapping
// ---------------------------------------------------------------------------

/**
 * Maps each ResolvedConfig key to the env-var name that overrides it.
 * All overrides are UPPER_SNAKE_CASE — the same as the key name itself.
 */
const ENV_VAR_MAP: Record<keyof ResolvedConfig, string> = {
  DATABASE_URL: 'DATABASE_URL',
  BETTER_AUTH_SECRET: 'BETTER_AUTH_SECRET',
  BETTER_AUTH_URL: 'BETTER_AUTH_URL',
  CONFIG_FILE_PATH: 'CONFIG_FILE_PATH',
  STASH_ROOTS: 'STASH_ROOTS',
  OIDC_ISSUER_URL: 'OIDC_ISSUER_URL',
  OIDC_CLIENT_ID: 'OIDC_CLIENT_ID',
  OIDC_CLIENT_SECRET: 'OIDC_CLIENT_SECRET',
  OIDC_ADMIN_GROUP_CLAIM: 'OIDC_ADMIN_GROUP_CLAIM',
  PASSWORD_LOGIN_ENABLED: 'PASSWORD_LOGIN_ENABLED',
  INSTANCE_NAME: 'INSTANCE_NAME',
  LOG_LEVEL: 'LOG_LEVEL',
  NOTIFICATION_PREFS: 'NOTIFICATION_PREFS',
  DEFAULT_TEMPLATE: 'DEFAULT_TEMPLATE',
};

/** Map YAML file keys (snake_case) to ResolvedConfig keys. */
const YAML_KEY_MAP: Record<string, keyof ResolvedConfig> = {
  database_url: 'DATABASE_URL',
  better_auth_secret: 'BETTER_AUTH_SECRET',
  better_auth_url: 'BETTER_AUTH_URL',
  config_file_path: 'CONFIG_FILE_PATH',
  stash_roots: 'STASH_ROOTS',
  oidc_issuer_url: 'OIDC_ISSUER_URL',
  oidc_client_id: 'OIDC_CLIENT_ID',
  oidc_client_secret: 'OIDC_CLIENT_SECRET',
  oidc_admin_group_claim: 'OIDC_ADMIN_GROUP_CLAIM',
  password_login_enabled: 'PASSWORD_LOGIN_ENABLED',
  instance_name: 'INSTANCE_NAME',
  log_level: 'LOG_LEVEL',
  notification_prefs: 'NOTIFICATION_PREFS',
  default_template: 'DEFAULT_TEMPLATE',
};

/** Keys with known shapes that we use as the canonical set. */
const ALL_KEYS = Object.keys(ENV_VAR_MAP) as Array<keyof ResolvedConfig>;

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function coerceValue(key: keyof ResolvedConfig, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;

  switch (key) {
    case 'STASH_ROOTS': {
      if (Array.isArray(raw)) return raw.map(String);
      if (typeof raw === 'string') return raw.split(':').filter(Boolean);
      return undefined;
    }
    case 'PASSWORD_LOGIN_ENABLED': {
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'string') {
        const lower = raw.toLowerCase();
        if (lower === 'true' || lower === '1' || lower === 'yes') return true;
        if (lower === 'false' || lower === '0' || lower === 'no') return false;
      }
      return undefined;
    }
    case 'LOG_LEVEL': {
      const valid = ['debug', 'info', 'warn', 'error'];
      const s = String(raw).toLowerCase();
      return valid.includes(s) ? s : undefined;
    }
    default:
      return String(raw);
  }
}

// ---------------------------------------------------------------------------
// DB access adapter — injectable for testing
// ---------------------------------------------------------------------------

export interface ConfigDbAdapter {
  /**
   * Read a single key from the instance_config table.
   * Returns undefined if the key is absent or the DB is unavailable.
   */
  readInstanceConfig(key: string): Promise<{ key: string; value: unknown } | undefined>;
  /**
   * Write a provenance entry. Failures are non-fatal.
   */
  writeProvenance(entry: ProvenanceEntry): Promise<void>;
}

/**
 * Production adapter — lazy-loads Drizzle client to avoid circular deps and
 * to allow the resolver to construct before the DB is ready.
 */
export const productionDbAdapter: ConfigDbAdapter = {
  async readInstanceConfig(key: string) {
    try {
      const { getDb } = await import('../db/client.js');
      const { instanceConfig } = await import('../db/schema.config.js');
      const { eq } = await import('drizzle-orm');
      const db = getDb();
      const rows = await (db as any)
        .select()
        .from(instanceConfig)
        .where(eq(instanceConfig.key, key))
        .limit(1);
      return rows[0] as { key: string; value: unknown } | undefined;
    } catch {
      return undefined;
    }
  },
  async writeProvenance(entry: ProvenanceEntry) {
    try {
      const { getDb } = await import('../db/client.js');
      const { configProvenance } = await import('../db/schema.config.js');
      const db = getDb();
      await (db as any)
        .insert(configProvenance)
        .values({
          key: entry.key,
          source: entry.source,
          resolvedAt: entry.resolvedAt,
          sourceDetail: entry.sourceDetail ?? null,
        })
        .onConflictDoUpdate({
          target: configProvenance.key,
          set: {
            source: entry.source,
            resolvedAt: entry.resolvedAt,
            sourceDetail: entry.sourceDetail ?? null,
          },
        });
    } catch {
      // Non-fatal — provenance is audit-only.
    }
  },
};

/**
 * No-op adapter used during test isolation or pre-DB-startup phases.
 */
export const nullDbAdapter: ConfigDbAdapter = {
  readInstanceConfig: async () => undefined,
  writeProvenance: async () => undefined,
};

// ---------------------------------------------------------------------------
// ConfigResolver
// ---------------------------------------------------------------------------

export class ConfigResolver {
  private resolved: ResolvedConfig | null = null;
  private provenance: Map<string, ProvenanceEntry> = new Map();
  private pendingWizardKeys: Set<string> = new Set();
  private readonly db: ConfigDbAdapter;

  /**
   * @param db - DB adapter. Defaults to the production adapter that
   *   lazy-loads Drizzle. Pass `nullDbAdapter` in tests to avoid needing
   *   a real database, or pass a custom adapter to inject DB mock data.
   */
  constructor(db: ConfigDbAdapter = productionDbAdapter) {
    this.db = db;
  }

  /**
   * Performs full three-tier resolution. Safe to call multiple times —
   * subsequent calls re-resolve and overwrite provenance.
   *
   * Throws ConfigurationError if any required boot key is absent from
   * tiers 1 and 2, or if an incompatible config combination is detected.
   */
  async resolve(): Promise<ResolvedConfig> {
    const env = process.env;

    // ── Tier-1: read env vars ────────────────────────────────────────────
    const fromEnv: Partial<Record<keyof ResolvedConfig, unknown>> = {};
    for (const key of ALL_KEYS) {
      const envVar = ENV_VAR_MAP[key];
      const raw = env[envVar];
      if (raw !== undefined && raw !== '') {
        fromEnv[key] = coerceValue(key, raw);
      }
    }

    // ── Tier-2: read YAML file ───────────────────────────────────────────
    const configFilePath =
      (fromEnv['CONFIG_FILE_PATH'] as string | undefined) ??
      (CONFIG_DEFAULTS.CONFIG_FILE_PATH as string);

    const fromFile = this._parseYamlFile(configFilePath);

    // ── Tier-3: read DB (instance_config) ───────────────────────────────
    // Only read keys that tiers 1 and 2 didn't supply.
    const fromDb: Partial<Record<keyof ResolvedConfig, unknown>> = {};
    for (const key of ALL_KEYS) {
      if (fromEnv[key] !== undefined || fromFile[key] !== undefined) continue;
      const row = await this.db.readInstanceConfig(key);
      if (row && row.value !== null && row.value !== undefined) {
        fromDb[key] = coerceValue(key, row.value);
      }
    }

    // ── Build resolved config + record provenance ────────────────────────
    const result: Partial<ResolvedConfig> = {};
    this.provenance = new Map();
    this.pendingWizardKeys = new Set();

    const resolvedAt = new Date();

    for (const key of ALL_KEYS) {
      let value: unknown = undefined;
      let source: ConfigSource = 'default';
      let sourceDetail: string | undefined;

      if (fromEnv[key] !== undefined) {
        value = fromEnv[key];
        source = 'secrets';
        sourceDetail = `env:${ENV_VAR_MAP[key]}`;
      } else if (fromFile[key] !== undefined) {
        value = fromFile[key];
        source = 'file';
        sourceDetail = `file:${configFilePath}`;
      } else if (fromDb[key] !== undefined) {
        value = fromDb[key];
        source = 'db';
        sourceDetail = 'instance_config';
      } else if ((CONFIG_DEFAULTS as Record<string, unknown>)[key] !== undefined) {
        value = (CONFIG_DEFAULTS as Record<string, unknown>)[key];
        source = 'default';
      }

      const provEntry: ProvenanceEntry = {
        key,
        source,
        resolvedAt,
        sourceDetail,
      };
      this.provenance.set(key, provEntry);

      if (value !== undefined) {
        (result as Record<string, unknown>)[key] = value;
      }
    }

    // ── Derive INSTANCE_NAME from hostname if not set ────────────────────
    if (!result.INSTANCE_NAME) {
      try {
        result.INSTANCE_NAME = os.hostname();
        this.provenance.set('INSTANCE_NAME', {
          key: 'INSTANCE_NAME',
          source: 'default',
          resolvedAt,
          sourceDetail: 'os.hostname()',
        });
      } catch {
        // hostname() can fail in restricted environments
      }
    }

    // ── Validate required boot keys ──────────────────────────────────────
    for (const key of REQUIRED_BOOT_KEYS) {
      if (!result[key]) {
        throw new ConfigurationError(
          `Required config key "${key}" is missing. ` +
            `Checked tiers: env var ${ENV_VAR_MAP[key as keyof ResolvedConfig]}, ` +
            `YAML file ${configFilePath}. ` +
            `Set the env var or add it to the config file.`,
        );
      }
    }

    // ── Mark wizard-deferrable keys without values ───────────────────────
    for (const key of WIZARD_DEFERRABLE_KEYS) {
      const val = result[key];
      if (val === undefined || (Array.isArray(val) && val.length === 0)) {
        this.pendingWizardKeys.add(key);
      }
    }

    // ── Validate OIDC-only mode consistency ──────────────────────────────
    const passwordLoginEnabled = result.PASSWORD_LOGIN_ENABLED as boolean;
    const hasOidc = !!(result.OIDC_ISSUER_URL && result.OIDC_CLIENT_ID && result.OIDC_CLIENT_SECRET);

    if (passwordLoginEnabled === false && !hasOidc) {
      throw new ConfigurationError(
        'OIDC-only mode requested (PASSWORD_LOGIN_ENABLED=false) ' +
          'but no OIDC provider is configured. ' +
          'Set OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET, ' +
          'or set PASSWORD_LOGIN_ENABLED=true.',
      );
    }

    // ── Persist provenance ───────────────────────────────────────────────
    // Fire-and-forget; failures are non-fatal (DB may not be ready yet).
    void Promise.allSettled(
      [...this.provenance.values()].map((e) => this.db.writeProvenance(e)),
    );

    this.resolved = result as ResolvedConfig;
    return this.resolved;
  }

  /**
   * Returns a resolved config key. Requires resolve() to have been called.
   * Throws if resolve() was not called first.
   */
  get<K extends keyof ResolvedConfig>(key: K): ResolvedConfig[K] {
    if (!this.resolved) {
      throw new ConfigurationError(
        'ConfigResolver.get() called before resolve(). Call resolve() first.',
      );
    }
    return this.resolved[key];
  }

  /**
   * Returns true if the key has no resolved value and is awaiting wizard input.
   */
  isPendingWizard(key: string): boolean {
    return this.pendingWizardKeys.has(key);
  }

  /**
   * Returns provenance for a key. Requires resolve() to have been called.
   */
  getProvenance(key: string): ProvenanceEntry {
    const entry = this.provenance.get(key);
    if (!entry) {
      throw new ConfigurationError(
        `No provenance found for key "${key}". ` +
          'Either resolve() was not called or the key does not exist.',
      );
    }
    return entry;
  }

  /**
   * Returns the fully resolved config object. Null until resolve() is called.
   */
  getResolved(): ResolvedConfig | null {
    return this.resolved;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Parses the YAML config file if it exists.
   * - Missing file → silent no-op (returns empty record).
   * - Malformed YAML → throws ConfigurationError with error details.
   * - Unknown keys → warns but does not fail.
   */
  private _parseYamlFile(
    filePath: string,
  ): Partial<Record<keyof ResolvedConfig, unknown>> {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = parseYaml(raw, { prettyErrors: true }) ?? {};
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConfigurationError(
        `Failed to parse YAML config file "${filePath}": ${msg}`,
      );
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigurationError(
        `YAML config file "${filePath}" must be a mapping (object) at the top level.`,
      );
    }

    const result: Partial<Record<keyof ResolvedConfig, unknown>> = {};
    const knownYamlKeys = new Set(Object.keys(YAML_KEY_MAP));

    for (const [yamlKey, value] of Object.entries(parsed)) {
      const configKey = YAML_KEY_MAP[yamlKey];
      if (!configKey) {
        // Unknown key — warn but continue.
        // We use console.warn here because the logger may not be initialised yet.
        console.warn(
          `[config] Unknown key "${yamlKey}" in YAML config file "${filePath}" — ignoring.`,
        );
        continue;
      }
      if (!knownYamlKeys.has(yamlKey)) continue;
      const coerced = coerceValue(configKey, value);
      if (coerced !== undefined) {
        result[configKey] = coerced;
      }
    }

    return result;
  }
}
