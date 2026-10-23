// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';

test.describe('cancellations', () => {
  // Quarantined against #501 -- recorded in the ledger with provenance.
  // This is the twin of the direct-surface finding (quarantined against #510).
  //
  // Release when a cancellation restocks its order's items.
  // eslint-disable-next-line no-skipped-tests
  test.skip('FINDING: cancelling an order does not restock its items (#501)', async ({
    request,
  }) => {
    const response = await request.post('/orders/o1/cancel');
    expect((await response.json()).restocked).toBe(3);
  });
});
