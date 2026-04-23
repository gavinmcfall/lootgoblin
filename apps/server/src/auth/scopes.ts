/**
 * API key scope definitions — V2-001-T5
 *
 * Three scope types are supported:
 *
 *   extension_pairing  — Browser extension. Creates/reads queue items and
 *                        source credentials. Prefix: lg_ext_
 *
 *   courier_pairing    — Courier agent on a remote LAN. Claims dispatch jobs
 *                        and reports status. Prefix: lg_cou_
 *
 *   programmatic       — Third-party integrations. Reserved for future routes.
 *                        Prefix: lg_api_
 *
 * Per-scope defaults are applied at key-creation time in /api/v1/api-keys.
 * Scope enforcement is performed by isValidApiKeyWithScope() in helpers.ts.
 *
 * Courier routes (dispatch claim, status report, heartbeat) will require
 * courier_pairing scope. Those routes are owned by V2-006 and do not exist
 * yet — the scope is reserved here so keys can be issued in advance.
 *
 * Programmatic scope is likewise reserved — no v2 route enforces it yet.
 * It targets future third-party integrations (webhooks, automation scripts).
 */

export const API_KEY_SCOPES = {
  extension_pairing: {
    prefix: 'lg_ext_',
    defaultExpirationDays: 365,
    rateLimitPerMinute: 600,
    description:
      'Browser extension pairing — used by the lootgoblin extension to relay authenticated source fetches and capture models into the library.',
  },
  courier_pairing: {
    prefix: 'lg_cou_',
    defaultExpirationDays: null, // no expiration
    rateLimitPerMinute: 1200,
    description:
      'Courier agent pairing — used by a Courier running on a remote LAN to claim dispatch jobs and relay them to local printers.',
  },
  programmatic: {
    prefix: 'lg_api_',
    defaultExpirationDays: 90,
    rateLimitPerMinute: 60,
    description: 'Programmatic API access for third-party integrations.',
  },
} as const;

export type ApiKeyScope = keyof typeof API_KEY_SCOPES;

export function isValidScope(s: string): s is ApiKeyScope {
  return s in API_KEY_SCOPES;
}
