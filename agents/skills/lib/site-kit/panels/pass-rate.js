// <canary-pass-rate> -- the pass-rate trend per suite, newest first (#1151
// phase 3, criterion 9). A run that counted no tests renders "—" and is
// announced; it is never 0%, and no rate rounds up to 100% (model.js).

import { CanaryPanel, el } from '../panel.js';
import {
  ABSENT,
  logicalRuns,
  passCounts,
  percent,
  scopeLabel,
} from '../model.js';

/** Why this run's rate is not shown, or null. */
function whyAbsent(run, denominator) {
  if (run.incomplete)
    return `${run.shards.reported} of ${run.shards.total} shards reported`;
  if (!(denominator > 0)) return 'no tests counted';
  return null;
}

function runItem(run) {
  const { numerator, denominator } = passCounts(run.totals);
  const absent = whyAbsent(run, denominator);
  const when = Number.isFinite(run.finished)
    ? new Date(run.finished).toISOString()
    : null;
  const detail = absent ?? `${numerator}/${denominator}`;
  const notRun = run.totals.interrupted
    ? `, ${run.totals.interrupted} interrupted`
    : '';
  return {
    run,
    absent,
    node: el(
      'li',
      {},
      when ? el('time', { datetime: when }, when.slice(0, 10)) : ABSENT,
      ' ',
      el('strong', {}, absent ? ABSENT : percent(numerator, denominator)),
      el('span', { class: 'muted' }, ` (${detail}${notRun})`),
    ),
  };
}

/** One sentence per kind of run whose rate or date could not be shown. */
function announce(items) {
  const count = (pred) => items.filter(pred).length;
  const lines = [
    [
      count((i) => i.run.incomplete),
      'are missing shards; their rate is shown as —',
    ],
    [
      count((i) => !i.run.incomplete && i.absent),
      'counted no tests; their rate is shown as —, not 0%',
    ],
    [
      count((i) => i.run.totals.interrupted > 0),
      'were interrupted; interrupted tests are left out of the rate',
    ],
    [
      count((i) => !Number.isFinite(i.run.finished)),
      'have no real finish time',
    ],
  ];
  return lines
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} run(s) ${what}.`);
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
    const all = [];
    const sections = [...bySuite.values()].map((runs) => {
      const items = runs.map(runItem);
      all.push(...items);
      return el(
        'section',
        {},
        el('h3', {}, `${scopeLabel(runs[0].scope)} · ${runs[0].suite}`),
        el('ol', {}, ...items.map((i) => i.node)),
      );
    });
    const abstentions = announce(all);
    return { nodes: sections, abstentions };
  }
}
