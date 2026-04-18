import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { runMigrations, countUsers, insertUser } from '@/db/client';
import { hashPassword } from '@/auth/password';

export async function POST(req: Request) {
  await runMigrations();
  const userCount = await countUsers();
  if (userCount > 0) return NextResponse.json({ error: 'Setup already done' }, { status: 409 });

  const form = await req.formData();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!username) return NextResponse.json({ error: 'Username required' }, { status: 400 });
  try {
    const hash = await hashPassword(password);
    await insertUser({
      id: randomUUID(),
      username,
      passwordHash: hash,
      role: 'admin',
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
