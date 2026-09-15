// REHEARSAL FIXTURE (#834, ADR 0018). Synthetic. Never run as a suite.
// Planted defect: the assertion compares a value with itself, so it passes
// whatever `tally` returns. canary-cassandra must flag it (VAC-001). Do NOT
// fix or suppress it.
import { expect, test } from 'vitest';

function tally(a, b) {
  return a + b;
}

test('tally adds two widgets', () => {
  const total = tally(2, 3);
  expect(total).toBe(total);
});
