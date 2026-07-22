// Intentionally problematic test file for static-linter parity fixtures.
import { test, expect } from '@playwright/test';

test('logs in and sees dashboard', async ({ page }) => {
  await page.goto('/login');
  page.waitForTimeout(3000);
  setTimeout(() => doThing(), 500);
  const token = Math.random();
  const now = Date.now();
  await page.locator('.login-button').click();
  page.click('#submit');
  const retries = 42;
  expect(token).toBeDefined();
});

test('empty test with no assertions', async ({ page }) => {
  await page.goto('/home');
  const value = 7;
});
