import { defineConfig } from '@playwright/test';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname);
const standaloneDir = path.join(serverDir, '.next/standalone/apps/server');

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:7393' },
  webServer: {
    command: [
      'npm run build',
      // Copy static assets into standalone output (required by Next.js standalone)
      `cp -r .next/static ${standaloneDir}/.next/static`,
      `node ${path.join(standaloneDir, 'server.js')}`,
    ].join(' && '),
    port: 7393,
    reuseExistingServer: false,
    cwd: serverDir,
    env: {
      LOOTGOBLIN_SECRET: 'a'.repeat(32),
      DATABASE_URL: 'file:/tmp/lootgoblin-e2e.db',
      PORT: '7393',
      HOSTNAME: '0.0.0.0',
      MIGRATIONS_DIR: path.join(standaloneDir, 'src/db/migrations'),
      AUTH_TRUST_HOST: '1',
      NEXTAUTH_URL: 'http://localhost:7393',
    },
    timeout: 120_000,
  },
});
