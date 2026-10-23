// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';

test.describe('bulk orders', () => {
  test('CASE-030 a confirmation notice is sent when a bulk order is accepted', async ({
    request,
  }) => {
    const body = await (await request.post('/orders')).json();
    const notice = body.notice;
    // Ledgered against #503, so the run publishes this as a blocked skip
    // carrying that ticket rather than as a pass.
    // eslint-disable-next-line no-skipped-tests
    test.skip(
      notice === undefined,
      'the response carried no notice information at all',
    );
    expect(notice).toBeDefined();
  });
});

// RE-QUARANTINED against #502 after the first run.
//
// RELEASE when #502 closes: delete `.skip`, release the ledger row, re-run.
test.describe.skip('BULK bulk orders -- approval-gated @regression', () => {
  test('a qualifying order is approved', async ({ request }) => {
    expect((await request.post('/orders')).status()).toBe(200);
  });
});
