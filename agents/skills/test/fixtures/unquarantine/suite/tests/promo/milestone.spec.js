// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';
import { requireLiveWindow } from './harness.js';

test.describe('spend milestones', () => {
  test('a $100 sale issues the $10 coupon and only that', async ({ request }) => {
    await requireLiveWindow(request, 'spend-milestone');
    expect((await request.post('/sale', { data: { amount: 100 } })).status()).toBe(200);
  });

  test('a $50 sale issues nothing', async ({ request }) => {
    expect((await request.post('/sale', { data: { amount: 50 } })).status()).toBe(200);
  });
});
