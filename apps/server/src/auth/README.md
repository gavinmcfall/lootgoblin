# Auth module

## Two API-key systems (as of V2-001-T7)

v2 currently operates two independent API-key systems:

### 1. Custom `api_keys` table (Drizzle-managed)

- Schema: `apps/server/src/db/schema.ts` → `apiKeys` table.
- Hash algorithm: argon2id (verify via `helpers.ts` → `findValidKeyRow`).
- Scopes: `extension_pairing | courier_pairing | programmatic` (see `auth/scopes.ts`).
- Managed via: `GET/POST /api/v1/api-keys` and `DELETE/PATCH /api/v1/api-keys/[id]`.
- No per-user ownership tracked in this table yet (ownerId added in a future cleanup).

### 2. BetterAuth `apikey` table (plugin-managed)

- Schema: `apps/server/src/db/schema.auth.ts` → `apikey` table.
- Managed via: `auth.api.createApiKey` / `auth.api.verifyApiKey`.
- Currently unused at runtime (table exists, no routes write to it via BetterAuth).

### Why they're separate

V2-001-T5 added the custom table to provide argon2id hashing + named scopes quickly.
V2-001-T7 kept them separate to avoid broadening the ACL consolidation scope.

### Planned unification (V2-001-T7b or follow-up task)

A future cleanup task will:

1. Migrate all `api_keys` rows to BetterAuth's `apikey` table (using `metadata` for
   scope storage, per gotcha #26).
2. Drop the custom `api_keys` table and `legacy_scopes` column.
3. Re-point `isValidApiKeyWithScope` to use `auth.api.verifyApiKey`.
4. Add per-user ownership via BetterAuth's `referenceId` field on `apikey`.

Until that task runs, `auth.api.verifyApiKey` will **not** find keys created
via `/api/v1/api-keys`, and vice versa.
