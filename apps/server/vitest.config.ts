// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: [],
    env: {
      LOOTGOBLIN_SECRET: 'a'.repeat(32),
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
