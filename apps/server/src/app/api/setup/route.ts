import { NextResponse } from 'next/server';
import { runMigrations } from '@/db/client';
import { auth } from '@/auth';
import { getDb } from '@/db/client';
import * as authSchema from '@/db/schema.auth';

/**
 * First-run setup endpoint — creates the initial admin user via BetterAuth.
 *
 * This route is intentionally public (no session required) — it's only
 * reachable during first-run setup. Subsequent calls are rejected with 409
 * if any user already exists in the BetterAuth user table.
 *
 * T8 will replace this with the full wizard UI + multi-step flow; for now it
 * provides a minimal working setup path.
 */
export async function POST(req: Request) {
  await runMigrations();

  // Check BetterAuth's user table for existing users.
  const db = getDb() as any;
  const existingUsers = await db.select({ id: authSchema.user.id }).from(authSchema.user).limit(1);
  if (existingUsers.length > 0) {
    return NextResponse.json({ error: 'Setup already done' }, { status: 409 });
  }

  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim();
  const name = String(form.get('name') ?? form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');

  if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 });
  if (!password) return NextResponse.json({ error: 'Password required' }, { status: 400 });

  try {
    // Use BetterAuth signUpEmail to create the first user with argon2id hashing.
    const result = await auth.api.signUpEmail({
      body: { email, name, password },
    });
    if (!result) {
      return NextResponse.json({ error: 'User creation failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
