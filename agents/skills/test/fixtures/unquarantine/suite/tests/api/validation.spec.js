// Fixture for canary-unquarantine: a synthetic suite carrying the quarantine
// shapes the audit must read. Never executed; read as text only.
import { test, expect } from '@playwright/test';

/**
 * The describe used to be `describe.skip`, and the ledger still says so: two
 * rows for the same skip, plus a phantom "removed" row katana wrote when the
 * skip was lifted in place. All three are stale.
 *
 * Release when TRK-1002 and TRK-1003 are fixed.
 */
test.describe('POST /customers rejects malformed create payloads', () => {
  // Quarantined against TRK-1002 -- recorded in the ledger with provenance.
  // eslint-disable-next-line no-skipped-tests
  test.skip('an empty JSON body is rejected in the body', async ({ request }) => {
    const response = await request.post('/customers', { data: {} });
    expect(response.status()).toBe(400);
  });

  test('a well-formed payload is accepted', async ({ request }) => {
    const response = await request.post('/customers', { data: { name: 'a' } });
    expect(response.status()).toBe(200);
  });
});
