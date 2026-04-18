import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: [],
    env: {
      LOOTGOBLIN_SECRET: 'a'.repeat(32),
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
