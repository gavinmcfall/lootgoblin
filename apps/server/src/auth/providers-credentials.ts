import Credentials from 'next-auth/providers/credentials';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getDb, schema } from '../db/client';
import { verifyPassword } from './password';
import { eq } from 'drizzle-orm';

type AnyDb = ReturnType<typeof drizzle>;

export const credentialsProvider = Credentials({
  name: 'Password',
  credentials: {
    username: { label: 'Username', type: 'text' },
    password: { label: 'Password', type: 'password' },
  },
  async authorize(creds) {
    if (!creds?.username || !creds?.password) return null;
    const db = getDb() as AnyDb;
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, String(creds.username)));
    if (!user?.passwordHash) return null;
    const ok = await verifyPassword(user.passwordHash, String(creds.password));
    if (!ok) return null;
    return { id: user.id, name: user.username, email: null, role: user.role };
  },
});
