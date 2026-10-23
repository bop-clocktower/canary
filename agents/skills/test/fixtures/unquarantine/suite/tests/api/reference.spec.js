// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';

test.describe('GET /card/series', () => {
  // Quarantined against #505 -- the credential is gateway-blocked. A green
  // run is the signal to delete `.skip` and release the ledger entry.
  // eslint-disable-next-line no-skipped-tests
  test.skip('FINDING: card series is unreachable, gateway-blocked by an access group (filed 2026-09-22)', async ({
    request,
  }) => {
    expect((await request.get('/card/series')).status()).toBe(200);
  });
});

test.describe('GET /events/event_data', () => {
  // Quarantined against #506 -- answers an edge 520.
  // eslint-disable-next-line no-skipped-tests
  test.skip('FINDING: event_data answers an edge/origin 520, not application data (filed 2026-09-22)', async ({
    request,
  }) => {
    expect((await request.get('/events/event_data')).status()).toBe(200);
  });

  // Parked against #999, which the tracker refuses to show.
  // eslint-disable-next-line no-skipped-tests
  test.skip('a row whose ticket cannot be read', async () => {});

  // Quarantined against #502 here, but the ledger row's own `issue` field
  // names #505 -- the field a producer wrote wins over a comment.
  // eslint-disable-next-line no-skipped-tests
  test.skip('a v2 row whose issue field outranks the comment', async () => {});
});
