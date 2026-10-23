// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';

test.describe('percent-back bonus', () => {
  // PARKED against #507: the sale's points side effect carries no expiry
  // date. RELEASE when #507 closes.
  // eslint-disable-next-line no-skipped-tests
  test.skip('TC-065 percent-back bonus points carry the configured expiry', async () => {});

  // PARKED against #507: the coupon side effect carries no expiryDate.
  // eslint-disable-next-line no-skipped-tests
  test.skip('the reward expires 60 days after the sale', async () => {});

  // eslint-disable-next-line no-skipped-tests
  test.skip('an unlinked parked case', async () => {
    expect(1).toBe(1);
  });
});
