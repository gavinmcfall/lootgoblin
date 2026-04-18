import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.beforeEach(() => {
  try { fs.unlinkSync('/tmp/lootgoblin-e2e.db'); } catch {}
});

test('first-run wizard creates admin and signs in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup/);
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'correct-horse-battery-staple');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/login/);
  await page.fill('input[placeholder=Username]', 'admin');
  await page.fill('input[placeholder=Password]', 'correct-horse-battery-staple');
  await page.click('button[type=submit]');
  // After sign-in the middleware+(app)/page.tsx redirects → /activity → 404 (page lands in C-4)
  // Assert we land on /activity (regardless of whether that page exists yet)
  await expect(page).toHaveURL(/\/activity$/);
});
