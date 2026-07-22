import { test, expect } from '@playwright/test';

test('button navigates home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button')).toBeVisible();
});
