// Fixture for canary-unquarantine. Never executed; read as text only.
import { test, expect } from '@playwright/test';

test.describe('returns', () => {
  // Quarantined against #501 -- recorded in the ledger with provenance.
  // This is the twin of the direct-surface finding (quarantined against #510).
  //
  // Release when a return reverses its sale's points.
  // eslint-disable-next-line no-skipped-tests
  test.skip('FINDING: a full return does not reverse the points its sale earned (filed 2026-09-08, #501)', async ({
    request,
  }) => {
    const response = await request.post('/returns', { data: { bill: 'b1' } });
    expect((await response.json()).reversed).toBe(100);
  });
});
