// <canary-pipeline-health> -- per suite: passing / failing / cancelled / dark /
// never reported (#1151 phase 3, criterion 10).
//
// "Never reported" needs a declared denominator (D12): with `suites: null`
// the panel says nothing is declared rather than guessing which suites are
// missing. Dark wins over any status: a green run from two weeks ago is not
// evidence the suite is green now.

import { CanaryPanel, el } from '../panel.js';
import {
  DARK_AFTER_DAYS,
  isDark,
  logicalRuns,
  scopeLabel,
  suiteKey,
} from '../model.js';

const BY_STATUS = {
  passed: 'passing',
  failed: 'failing',
  cancelled: 'cancelled',
};

function stateOf(latest, now) {
  if (!latest) return { state: 'never-reported', text: 'never reported' };
  if (isDark(latest.finished, now))
    return {
      state: 'dark',
      text: `dark: no run in ${DARK_AFTER_DAYS} days`,
    };
  const state = BY_STATUS[latest.status];
  return { state, text: state };
}

/** Declared suites first, then any suite that reported without being declared. */
function suiteRows(doc, bySuite) {
  const rows = new Map();
  for (const s of doc.suites ?? [])
    rows.set(suiteKey(s.scope, s.suite), { scope: s.scope, suite: s.suite });
  for (const [key, runs] of bySuite)
    if (!rows.has(key))
      rows.set(key, { scope: runs[0].scope, suite: runs[0].suite });
  return rows;
}

export class PipelineHealth extends CanaryPanel {
  get heading() {
    return 'Pipeline health';
  }

  build(doc) {
    const abstentions =
      doc.suites === null
        ? [
            'No expected suites are declared, so a suite that never reported cannot be shown.',
          ]
        : [];
    const bySuite = logicalRuns(doc.runs);
    const rows = suiteRows(doc, bySuite);
    if (rows.size === 0)
      return {
        nodes: [],
        abstentions: [...abstentions, 'No suite has reported a run.'],
      };
    const items = [...rows].map(([key, s]) => {
      const { state, text } = stateOf(bySuite.get(key)?.[0], this.now());
      return el(
        'li',
        { 'data-state': state },
        `${scopeLabel(s.scope)} · ${s.suite}: `,
        el('strong', {}, text),
      );
    });
    return { nodes: [el('ul', {}, ...items)], abstentions };
  }
}
