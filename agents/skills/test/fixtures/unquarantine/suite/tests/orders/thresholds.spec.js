// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';
import { requireOpenWarehouse } from './harness.js';

test.describe('order thresholds', () => {
  test('a 100-unit order reserves stock and only that', async ({ request }) => {
    await requireOpenWarehouse(request, 'bulk-hours');
    expect(
      (await request.post('/orders', { data: { units: 100 } })).status(),
    ).toBe(200);
  });

  test('a 50-unit order reserves nothing', async ({ request }) => {
    expect(
      (await request.post('/orders', { data: { units: 50 } })).status(),
    ).toBe(200);
  });
});
