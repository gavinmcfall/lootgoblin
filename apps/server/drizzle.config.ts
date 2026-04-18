import { defineConfig } from 'drizzle-kit';
const url = process.env.DATABASE_URL ?? 'file:./lootgoblin.db';
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: url.startsWith('postgres') ? 'postgresql' : 'sqlite',
  dbCredentials: url.startsWith('postgres') ? { url } : { url: url.replace(/^file:/, '') },
});
