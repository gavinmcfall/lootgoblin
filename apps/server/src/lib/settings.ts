import { getDb, schema } from '../db/client';
import { eq } from 'drizzle-orm';

export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  const db = getDb();
  const [row] = await (db as any).select().from(schema.settings).where(eq(schema.settings.key, key));
  return row?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = getDb();
  const existing = await getSetting(key);
  if (existing === undefined) {
    await (db as any).insert(schema.settings).values({ key, value });
  } else {
    await (db as any).update(schema.settings).set({ value, updatedAt: new Date() }).where(eq(schema.settings.key, key));
  }
}
