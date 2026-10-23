// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';

test.describe('GET /warehouses', () => {
  // Quarantined against #505 -- the credential lacks a permission. A green
  // run is the signal to delete `.skip` and release the ledger entry.
  // eslint-disable-next-line no-skipped-tests
  test.skip('FINDING: the warehouse list is unreachable, blocked by a missing permission', async ({
    request,
  }) => {
    expect((await request.get('/warehouses')).status()).toBe(200);
  });
});

test.describe('GET /inventory/levels', () => {
  // Quarantined against #506 -- answers a proxy 502.
  // eslint-disable-next-line no-skipped-tests
  test.skip('FINDING: stock levels answer a proxy 502, not application data', async ({
    request,
  }) => {
    expect((await request.get('/inventory/levels')).status()).toBe(200);
  });

  // Parked against #999, which the tracker refuses to show.
  // eslint-disable-next-line no-skipped-tests
  test.skip('a row whose ticket cannot be read', async () => {});

  // Quarantined against #502 here, but the ledger row's own `issue` field
  // names #505 -- the field a producer wrote wins over a comment.
  // eslint-disable-next-line no-skipped-tests
  test.skip('a v2 row whose issue field outranks the comment', async () => {});
});
