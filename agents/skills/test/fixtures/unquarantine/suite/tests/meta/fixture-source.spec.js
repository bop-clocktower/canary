// Fixture for canary-unquarantine. Never executed; read as text only.
// A meta test that writes skip-shaped source into a template literal. None of
// it is a real marker, and the unledgered scan must not list it.
import { test, expect } from '@playwright/test';

const PARKED = `import { test } from '@playwright/test';

test.describe.skip('a parked block', () => {
    test('a case inside it', async () => {});
});
`;

// test.skip('a commented-out skip is not a marker either', () => {});

test('the fixture source mentions a skip', () => {
  expect(PARKED).toContain('describe.skip');
});
