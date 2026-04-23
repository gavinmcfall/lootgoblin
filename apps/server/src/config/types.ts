/**
 * V2 boot-time and runtime-mutable config schema.
 *
 * Boot-time keys are resolved from tier-1 (env/secrets) or tier-2 (YAML file) only.
 * Runtime-mutable keys can additionally be sourced from tier-3 (InstanceConfig DB table).
 *
 * Other pillars (Stash, Grimoire, Forge, Ledger, Courier) add their own keys later.
 * T3 scope is limited to the keys listed here.
 */

/** The three resolution tiers plus synthetic sources. */
export type ConfigSource = 'secrets' | 'file' | 'db' | 'default';

/** Per-key audit record written by the resolver on every resolve() call. */
export interface ProvenanceEntry {
  key: string;
  source: ConfigSource;
  resolvedAt: Date;
  /** Extra detail, e.g. the YAML file path or the env-var name. */
  sourceDetail?: string;
}

/**
 * Fully resolved config. All optional fields have been coerced to their
 * documented defaults where applicable. Absent optional fields remain
 * undefined so callers can distinguish "set" from "not set".
 */
export interface ResolvedConfig {
  // ── Boot-time keys (tier-1 or tier-2 only) ──────────────────────────────
  /** SQLite file path or postgres:// URL. Required. */
  DATABASE_URL: string;
  /** BetterAuth signing secret. Required. */
  BETTER_AUTH_SECRET: string;
  /** Canonical base URL for BetterAuth (e.g. https://lootgoblin.example.com). Required. */
  BETTER_AUTH_URL: string;
  /** Path to the YAML config file. Default: /config/lootgoblin.yml */
  CONFIG_FILE_PATH: string;
  /**
   * One or more absolute filesystem paths that Stash will scan.
   * At least one is required; absence marks the key pending-wizard.
   */
  STASH_ROOTS: string[];
  /** OIDC provider discovery URL (optional). */
  OIDC_ISSUER_URL?: string;
  /** OIDC client ID (required when OIDC_ISSUER_URL is set). */
  OIDC_CLIENT_ID?: string;
  /** OIDC client secret (required when OIDC_ISSUER_URL is set). */
  OIDC_CLIENT_SECRET?: string;
  /**
   * Group claim value that maps to the admin role.
   * Default: 'admin'
   */
  OIDC_ADMIN_GROUP_CLAIM: string;
  /**
   * Whether local password login is enabled.
   * Default: true
   */
  PASSWORD_LOGIN_ENABLED: boolean;
  /**
   * Human-readable name for this instance.
   * Default: derived from os.hostname().
   */
  INSTANCE_NAME: string;
  /** Pino log level. Default: 'info' */
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  // ── Runtime-mutable keys (tier-1/2/3 or default) ─────────────────────────
  /**
   * Notification preferences JSON blob. Shape owned by T8 wizard.
   * Default: '{}' (empty object, no notifications configured).
   */
  NOTIFICATION_PREFS: string;
  /**
   * Default naming template string for Stash items.
   * Default: '{creator}/{title}' — T8 wizard or Stash UI can update via DB.
   */
  DEFAULT_TEMPLATE: string;
}

/**
 * Keys that MUST be present from tier-1 or tier-2 to allow startup.
 * Missing any of these throws ConfigurationError and halts the process.
 */
export const REQUIRED_BOOT_KEYS: ReadonlyArray<keyof ResolvedConfig> = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
] as const;

/**
 * Keys that are expected but can be deferred to the setup wizard.
 * Missing them marks the key as pending-wizard rather than halting startup.
 */
export const WIZARD_DEFERRABLE_KEYS: ReadonlyArray<keyof ResolvedConfig> = [
  'STASH_ROOTS',
] as const;

/** Defaults applied when no tier supplies a value. */
export const CONFIG_DEFAULTS: Partial<ResolvedConfig> = {
  CONFIG_FILE_PATH: '/config/lootgoblin.yml',
  STASH_ROOTS: [],
  OIDC_ADMIN_GROUP_CLAIM: 'admin',
  PASSWORD_LOGIN_ENABLED: true,
  LOG_LEVEL: 'info',
  NOTIFICATION_PREFS: '{}',
  DEFAULT_TEMPLATE: '{creator}/{title}',
} as const;
