import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

let cached: ReturnType<typeof drizzleSqlite> | ReturnType<typeof drizzlePg> | null = null;

export function getDb(url = process.env.DATABASE_URL ?? 'file:./lootgoblin.db') {
  if (cached) return cached;
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
  return cached;
}

export async function runMigrations(url = process.env.DATABASE_URL ?? 'file:./lootgoblin.db') {
  // Resolves relative to this compiled file, not process.cwd(),
  // so it works whether Next.js runs from repo root or apps/server/.
  const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
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
