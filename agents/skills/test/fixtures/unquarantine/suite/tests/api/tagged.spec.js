// Fixture for canary-unquarantine. Never executed; read as text only.
// Tag-style quarantine with no ledger row: the unledgered scan must list it,
// with the ticket its comment names.
import { test, expect } from '@playwright/test';

test.describe('refunds', () => {
  // Known failure: https://acme.atlassian.net/browse/CORE-202
  test('a refund posts a credit @known-failure', async ({ request }) => {
    expect((await request.post('/refunds')).status()).toBe(200);
  });

  test('a refund is listed', async ({ request }) => {
    expect((await request.get('/refunds')).status()).toBe(200);
  });
});
