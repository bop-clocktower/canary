// <canary-flaky> -- distinct flaky tests over the window, from the feed's
// flaky[] section (#1151 phase 3, D13, criterion 23). One row per test, never
// one per occurrence. "No test flaked" is said only when some run carried
// per-test results; otherwise the panel abstains (nothing was measured).

import { CanaryPanel, el } from '../panel.js';
import { scopeLabel } from '../model.js';

const row = (f) =>
  el(
    'li',
    {},
    el('strong', {}, f.title),
    ' ',
    el('code', {}, f.file),
    el(
      'span',
      { class: 'muted' },
      ` · ${scopeLabel(f.scope)} · ${f.suite} · flaky in ${f.flaky_runs}/${f.window_runs} runs`,
    ),
  );

export class Flaky extends CanaryPanel {
  get heading() {
    return 'Flaky tests';
  }

  build(doc) {
    if (doc.runs.length === 0)
      return {
        nodes: [],
        abstentions: ['No runs in the feed, so flakiness was not measured.'],
      };
    if (doc.flaky.length > 0) {
      const rows = [...doc.flaky].sort(
        (a, b) => b.flaky_runs - a.flaky_runs || a.title.localeCompare(b.title),
      );
      return {
        nodes: [
          el('p', { class: 'muted' }, `${rows.length} distinct flaky test(s)`),
          el('ul', { class: 'rows' }, ...rows.map(row)),
        ],
        abstentions: [],
      };
    }
    if (doc.runs.every((r) => r.results === null))
      return {
        nodes: [],
        abstentions: [
          'No run carries per-test results, so flakiness was not measured.',
        ],
      };
    return {
      nodes: [el('p', {}, 'No test flaked in the window.')],
      abstentions: [],
    };
  }
}
