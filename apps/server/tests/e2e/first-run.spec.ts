import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.beforeEach(() => {
  try { fs.unlinkSync('/tmp/lootgoblin-e2e.db'); } catch {}
});

test('first-run wizard creates admin and signs in', async ({ page }) => {
  // Step 1: redirects to /setup on first run
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup/);

  // Step 2: admin step — fill and submit
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'correct-horse-battery-staple');
  await page.click('button[type=submit]');

  // After admin creation + auto sign-in, wizard advances to library step
  await expect(page).toHaveURL(/\/setup/);

  // Step 3: skip library creation
  await page.click('button:has-text("Skip")');

  // Step 4: extension pairing — finish setup
  await page.click('button:has-text("Finish setup")');

  // After finishing, the wizard redirects to /activity
  await expect(page).toHaveURL(/\/activity$/);
});
