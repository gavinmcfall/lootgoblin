/**
 * OAuth state table — V2-003-T9
 *
 * Stores transient state values + (PKCE) code verifiers for OAuth
 * authorization-code flows initiated via /api/v1/source-auth/:sourceId/oauth/start.
 *
 * The `state` value is an opaque random 32-byte hex returned to the user-agent
 * in the authorize redirect; the `oauth/callback` endpoint validates it before
 * exchanging the code. PKCE flows (Google) also persist the `code_verifier`.
 *
 * Lifecycle
 * ─────────
 * Rows are created at /oauth/start and deleted at /oauth/callback via an
 * atomic `DELETE ... RETURNING` (single-use semantics — defends against
 * authorization-code replay attacks: the second concurrent callback sees no
 * row and returns 400).
 *
 * Lazy purge of abandoned rows
 * ─────────────────────────────
 * If the user never completes the flow, the row would otherwise leak. The
 * /oauth/start handler runs an opportunistic sweep on ~1% of calls
 * (`DELETE FROM oauth_state WHERE expires_at < now`) so accumulated rows
 * stay bounded by the 10-minute TTL × create rate without a separate cron.
 *
 * Uniqueness
 * ──────────
 * `state` is uniquely indexed — defends against pathological collisions
 * across concurrent /oauth/start calls (with 32-byte randomness collisions
 * are astronomically unlikely; enforcing the invariant in the schema is
 * defense-in-depth).
 */

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './schema.auth';

export const oauthState = sqliteTable(
  'oauth_state',
  {
    id: text('id').primaryKey(),
    /** FK → BetterAuth user.id. Cascade on user delete. */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** SourceId value (e.g. 'sketchfab', 'google-drive'). */
    sourceId: text('source_id').notNull(),
    /** Opaque random 32-byte hex — the OAuth `state` parameter. UNIQUE. */
    state: text('state').notNull(),
    /** PKCE code_verifier (Google flows). NULL for non-PKCE flows. */
    codeVerifier: text('code_verifier'),
    /** Authorize-redirect URL fragment used at start time, useful for diagnostics. */
    redirectUri: text('redirect_uri'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    /** Hard cutoff. Callback handler MUST reject expired rows. */
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('oauth_state_user_idx').on(t.userId),
    /** Unique — single state per active flow; defends against replay races. */
    uniqueIndex('oauth_state_state_uniq').on(t.state),
    index('oauth_state_expires_idx').on(t.expiresAt),
  ],
);
