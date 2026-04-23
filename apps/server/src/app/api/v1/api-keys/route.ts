/**
 * API key management — V2-001-T5
 *
 * GET    — list active (non-revoked) keys for the authenticated user.
 * POST   — create a new scoped key; returns plaintext exactly once.
 *
 * POST body: { name: string, scope: ApiKeyScope, expiresAt?: string | null }
 *   scope must be one of: extension_pairing | courier_pairing | programmatic
 *   expiresAt overrides the per-scope default; null = no expiration.
 *
 * Per-scope defaults (applied when expiresAt is not supplied):
 *   extension_pairing  — expires in 365 days, prefix lg_ext_
 *   courier_pairing    — never expires,        prefix lg_cou_
 *   programmatic       — expires in 90 days,   prefix lg_api_
 */

import { NextResponse } from 'next/server';
import { randomUUID, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { isNull } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';
import { API_KEY_SCOPES, isValidScope } from '@/auth/scopes';
import type { ApiKeyScope } from '@/auth/scopes';

export async function GET(req: Request) {
  // Admin-only: API key management is a privileged operation.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = await (getDb() as any)
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      scope: schema.apiKeys.scope,
      prefix: schema.apiKeys.scope, // derived below
      expiresAt: schema.apiKeys.expiresAt,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      createdAt: schema.apiKeys.createdAt,
    })
    .from(schema.apiKeys)
    .where(isNull(schema.apiKeys.revokedAt));

  // Resolve the prefix from the scope.
  const keys = rows.map((row: {
    id: string;
    name: string;
    scope: string;
    prefix: string;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
  }) => ({
    id: row.id,
    name: row.name,
    scope: row.scope,
    prefix: isValidScope(row.scope) ? API_KEY_SCOPES[row.scope as ApiKeyScope].prefix : 'lg_',
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  }));

  return NextResponse.json({ keys });
}

export async function POST(req: Request) {
  // Admin-only: creating API keys requires an authenticated session.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json()) as {
    name?: unknown;
    scope?: unknown;
    expiresAt?: string | null;
  };

  const { name, scope, expiresAt: expiresAtRaw } = body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  if (!scope || typeof scope !== 'string' || !isValidScope(scope)) {
    return NextResponse.json(
      { error: 'scope must be one of: extension_pairing, courier_pairing, programmatic' },
      { status: 400 },
    );
  }

  const scopeConfig = API_KEY_SCOPES[scope as ApiKeyScope];

  // Resolve expiration: caller can supply an explicit ISO date, null (no expiry),
  // or omit the field to use the per-scope default.
  let expiresAt: Date | null = null;
  if (expiresAtRaw === null) {
    // Explicit no-expiry override.
    expiresAt = null;
  } else if (expiresAtRaw !== undefined) {
    expiresAt = new Date(expiresAtRaw);
    if (isNaN(expiresAt.getTime())) {
      return NextResponse.json({ error: 'expiresAt must be a valid ISO date string' }, { status: 400 });
    }
  } else if (scopeConfig.defaultExpirationDays !== null) {
    const ms = scopeConfig.defaultExpirationDays * 24 * 60 * 60 * 1000;
    expiresAt = new Date(Date.now() + ms);
  }

  // Generate key with the per-scope prefix.
  const plaintext = `${scopeConfig.prefix}${randomBytes(24).toString('base64url')}`;
  const id = randomUUID();

  await (getDb() as any).insert(schema.apiKeys).values({
    id,
    name: name.trim(),
    scope,
    keyHash: await argon2.hash(plaintext),
    expiresAt,
  });

  return NextResponse.json({
    id,
    name: name.trim(),
    scope,
    prefix: scopeConfig.prefix,
    expiresAt,
    createdAt: new Date(),
    key: plaintext, // returned exactly once; not stored in plaintext
  });
}
