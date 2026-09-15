// REHEARSAL FIXTURE (#834, ADR 0018). Synthetic. Never run as a suite.
// Planted defect: the test reads the real wall clock, so its outcome depends
// on when it runs. canary-blackhawk must flag it (BH001-wall-clock). Do NOT
// fix or suppress it.
import { expect, test } from 'vitest';

test('stamps a widget with the current time', () => {
  const stampedAt = Date.now();
  expect(stampedAt).toBeGreaterThan(0);
});
