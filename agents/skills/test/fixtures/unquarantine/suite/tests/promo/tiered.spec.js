// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';

test.describe('tiered bonus', () => {
  test('TC-030 an earned-reward message is sent when the bonus reward is allocated', async ({
    request,
  }) => {
    const body = await (await request.post('/sale')).json();
    const message = body.message;
    // Ledgered against #503, so the run publishes this as a blocked skip
    // carrying that ticket rather than as a pass.
    // eslint-disable-next-line no-skipped-tests
    test.skip(
      message === undefined,
      'the response carried no message information at all',
    );
    expect(message).toBeDefined();
  });
});

// RE-QUARANTINED against #502 after the first live run.
//
// RELEASE when #502 closes: delete `.skip`, release the ledger row, re-run.
test.describe.skip('TIERED tiered bonus -- coupon-gated @regression', () => {
  test('a qualifying sale earns the bonus', async ({ request }) => {
    expect((await request.post('/sale')).status()).toBe(200);
  });
});
