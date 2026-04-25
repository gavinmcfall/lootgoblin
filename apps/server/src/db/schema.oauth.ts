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
 * Rows expire after 10 minutes — callers (or a sweeper) prune `expires_at < now`.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
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
    /** Opaque random 32-byte hex — the OAuth `state` parameter. */
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
    index('oauth_state_state_idx').on(t.state),
    index('oauth_state_expires_idx').on(t.expiresAt),
  ],
);
