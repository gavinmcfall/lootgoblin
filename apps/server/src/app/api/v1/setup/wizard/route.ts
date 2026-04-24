/**
 * POST /api/v1/setup/wizard — V2-001-T8
 *
 * Accepts { key: string, value: string } and writes the value to the
 * instance_config table (tier-3 config source). After writing, calls
 * configResolver.resolve() so the key leaves the pending set.
 *
 * Gate: only accepts submissions if getFirstRunState() returns needsSetup: true.
 * Returns 409 if setup is already complete.
 *
 * Returns the updated FirstRunState after the write.
 */

import { NextResponse } from 'next/server';
import { getFirstRunState } from '@/setup/first-run';
import { configResolver } from '@/config';

export async function POST(req: Request) {
  // Gate: reject if setup is already done.
  const before = await getFirstRunState();
  if (!before.needsSetup) {
    return NextResponse.json({ error: 'setup-already-done' }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).key !== 'string' ||
    typeof (body as Record<string, unknown>).value !== 'string'
  ) {
    return NextResponse.json(
      { error: 'body must be { key: string, value: string }' },
      { status: 400 },
    );
  }

  const { key, value } = body as { key: string; value: string };

  // Write to instance_config (tier-3).
  const { getDb } = await import('@/db/client');
  const { instanceConfig } = await import('@/db/schema.config');
  const db = getDb() as any;

  await db
    .insert(instanceConfig)
    .values({ key, value })
    .onConflictDoUpdate({
      target: instanceConfig.key,
      set: { value, updatedAt: new Date() },
    });

  // Re-resolve config so the pending set is refreshed.
  try {
    await configResolver.resolve();
  } catch {
    // resolve() can throw if a required key is still missing — non-fatal here;
    // the write succeeded, the pending-wizard check will reflect the new state.
  }

  // Return updated state.
  const after = await getFirstRunState();
  return NextResponse.json(after);
}
