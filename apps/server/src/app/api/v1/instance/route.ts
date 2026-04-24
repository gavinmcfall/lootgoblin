/**
 * GET /api/v1/instance — V2-001-T6
 *
 * Unauthenticated endpoint. Returns the instance's public identity triple:
 *   { id, public_key, name }
 *
 * Couriers and extension pairing flows call this BEFORE they have credentials
 * to retrieve the Ed25519 public key needed to verify signed pair tokens.
 *
 * Returns 503 if the instance has not been bootstrapped yet (should not happen
 * in normal operation — bootstrap runs in instrumentation.ts on every boot).
 */

import { NextResponse } from 'next/server';
import { getInstanceIdentityPublic } from '@/identity';

export async function GET() {
  const identity = await getInstanceIdentityPublic();
  if (!identity) {
    return NextResponse.json({ error: 'not-yet-bootstrapped' }, { status: 503 });
  }
  return NextResponse.json({
    id: identity.id,
    public_key: identity.public_key,
    name: identity.name,
  });
}
