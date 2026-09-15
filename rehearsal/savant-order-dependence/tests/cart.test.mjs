// REHEARSAL FIXTURE (#834, ADR 0018). Synthetic. Never run as a suite.
// Planted defect: a module-level array that one test pushes into and the next
// reads, so the second test passes only after the first. canary-savant must
// flag it (SV001-module-mutable-global). Do NOT fix or suppress it.
import { expect, test } from 'vitest';

const widgets = [];

test('adds a widget', () => {
  widgets.push('sprocket');
  expect(widgets.length).toBe(1);
});

test('still sees the widget added above', () => {
  expect(widgets.length).toBe(1);
});
