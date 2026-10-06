// <canary-pass-rate> -- the pass-rate trend per suite, newest first (#1151
// phase 3, criterion 9). A run that counted no tests renders "—" and is
// announced; it is never 0%, and no rate rounds up to 100% (model.js).

import { CanaryPanel, el } from '../panel.js';
import { logicalRuns, passCounts, percent, scopeLabel } from '../model.js';

function runItem(run) {
  const { numerator, denominator } = passCounts(run.totals);
  const when = new Date(run.finished).toISOString();
  return {
    empty: !(denominator > 0),
    node: el(
      'li',
      {},
      el('time', { datetime: when }, when.slice(0, 10)),
      ' ',
      el('strong', {}, percent(numerator, denominator)),
      el('span', { class: 'muted' }, ` (${numerator}/${denominator})`),
    ),
  };
}

export class PassRate extends CanaryPanel {
  get heading() {
    return 'Pass rate';
  }

  build(doc) {
    const bySuite = logicalRuns(doc.runs);
    if (bySuite.size === 0)
      return {
        nodes: [],
        abstentions: ['No runs in the feed, so there is no pass rate.'],
      };
    let empty = 0;
    const sections = [...bySuite.values()].map((runs) => {
      const items = runs.map(runItem);
      empty += items.filter((i) => i.empty).length;
      return el(
        'section',
        {},
        el('h3', {}, `${scopeLabel(runs[0].scope)} · ${runs[0].suite}`),
        el('ol', {}, ...items.map((i) => i.node)),
      );
    });
    const abstentions = empty
      ? [`${empty} run(s) counted no tests; their rate is shown as —, not 0%.`]
      : [];
    return { nodes: sections, abstentions };
  }
}
