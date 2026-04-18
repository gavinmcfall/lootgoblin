import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
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

/**
 * Returns the number of rows in the users table.
 * Uses a raw SQL query to avoid the TypeScript union-type incompatibility
 * that arises when calling dialect-specific methods on the union return type
 * of `getDb()`.
 */
export async function countUsers(): Promise<number> {
  const url = process.env.DATABASE_URL ?? 'file:./lootgoblin.db';
  if (url.startsWith('postgres')) {
    const client = postgres(url);
    const result = await client`SELECT count(*)::int AS value FROM users`;
    await client.end();
    return Number(result[0]?.value ?? 0);
  } else {
    const file = url.replace(/^file:/, '');
    const sqlite = new Database(file);
    const row = sqlite.prepare('SELECT count(*) AS value FROM users').get() as { value: number } | undefined;
    sqlite.close();
    return row?.value ?? 0;
  }
}

/**
 * Inserts a new user row. Uses raw SQL to avoid the TypeScript union-type
 * incompatibility on `getDb()`.
 */
export async function insertUser(user: {
  id: string;
  username: string;
  passwordHash: string | null;
  role: string;
}): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'file:./lootgoblin.db';
  if (url.startsWith('postgres')) {
    const client = postgres(url);
    await client`INSERT INTO users (id, username, password_hash, role) VALUES (${user.id}, ${user.username}, ${user.passwordHash}, ${user.role})`;
    await client.end();
  } else {
    const file = url.replace(/^file:/, '');
    const sqlite = new Database(file);
    sqlite
      .prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, unixepoch() * 1000)')
      .run(user.id, user.username, user.passwordHash, user.role);
    sqlite.close();
  }
}

export async function runMigrations(url = process.env.DATABASE_URL ?? 'file:./lootgoblin.db') {
  const migrationsFolder = resolveMigrationsFolder();
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

function resolveMigrationsFolder(): string {
  const candidates: Array<string | undefined> = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), 'src/db/migrations'),
    path.resolve(process.cwd(), 'apps/server/src/db/migrations'),
    (() => {
      try {
        // Build the path string dynamically so webpack's static analyser cannot
        // resolve it at bundle time (avoids "Module not found: Can't resolve
        // './migrations'" in Next.js standalone builds).
        const rel = './migr' + 'ations';
        return fileURLToPath(/* webpackIgnore: true */ new URL(rel, import.meta.url));
      }
      catch { return undefined; }
    })(),
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (fs.existsSync(path.join(c, 'meta', '_journal.json'))) return c;
  }
  throw new Error(
    `Migrations folder not found. Tried: ${candidates.filter(Boolean).join(', ')}. ` +
    `Set MIGRATIONS_DIR env var to the directory containing meta/_journal.json.`,
  );
}

export { schema };
