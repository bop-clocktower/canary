// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';

test.describe('stock reservations', () => {
  // PARKED against #507: the order's hold side effect carries no expiry
  // date. RELEASE when #507 closes.
  // eslint-disable-next-line no-skipped-tests
  test.skip('CASE-065 a reservation carries the configured expiry', async () => {});

  // PARKED against #507: the hold side effect carries no heldUntil.
  // eslint-disable-next-line no-skipped-tests
  test.skip('a reservation lapses 60 days after the order', async () => {});

  // eslint-disable-next-line no-skipped-tests
  test.skip('an unlinked parked case', async () => {
    expect(1).toBe(1);
  });
});
