import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

let cached: ReturnType<typeof drizzleSqlite> | ReturnType<typeof drizzlePg> | null = null;
let cachedUrl: string | null = null;

export function getDb(url = process.env.DATABASE_URL ?? 'file:./lootgoblin.db') {
  if (cached && cachedUrl === url) return cached;
  if (url.startsWith('postgres')) {
    const client = postgres(url);
    cached = drizzlePg(client, { schema });
  } else {
    const file = url.replace(/^file:/, '');
    const sqlite = new Database(file);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    cached = drizzleSqlite(sqlite, { schema });
  }
  cachedUrl = url;
  return cached;
}

export function resetDbCache(): void {
  cached = null;
  cachedUrl = null;
}

export async function runMigrations(url = process.env.DATABASE_URL ?? 'file:./lootgoblin.db') {
  // MIGRATIONS_DIR env override lets standalone/bundled builds (e.g. Next.js
  // standalone output) point at the real migrations folder, since import.meta.url
  // would otherwise resolve into .next/server/chunks/… at runtime.
  const migrationsFolder =
    process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL(/* webpackIgnore: true */ './migrations', import.meta.url));
  if (url.startsWith('postgres')) {
    const client = postgres(url);
    await migratePg(drizzlePg(client), { migrationsFolder });
    await client.end();
  } else {
    const file = url.replace(/^file:/, '');
    const sqlite = new Database(file);
    migrateSqlite(drizzleSqlite(sqlite), { migrationsFolder });
    sqlite.close();
  }
}

export { schema };
