// REHEARSAL FIXTURE (#1188, ADR 0018). Synthetic. Never run as a suite.
// Planted defect: the component test reads the real wall clock AFTER an
// apostrophe in JSX text. Read raw, the apostrophe opens a phantom string that
// hides the call, so this file proves the JSX masking path still fires.
// canary-blackhawk must flag it (BH001-wall-clock). Do NOT fix or suppress it.
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';

test('stamps a banner with the current time', () => {
  const view = render(<p>It's {Date.now()}</p>);
  expect(view.container.textContent).toContain("It's");
});
