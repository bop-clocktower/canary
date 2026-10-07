// <canary-pass-rate> -- the pass-rate trend per suite, newest first (#1151
// phase 3, criterion 9). A run that counted no tests renders "—" and is
// announced; it is never 0%, and no rate rounds up to 100% (model.js).

import { CanaryPanel, el } from '../panel.js';
import {
  ABSENT,
  logicalRuns,
  passCounts,
  percent,
  rateProblem,
  scopeLabel,
} from '../model.js';

function runItem(run) {
  const { numerator, denominator } = passCounts(run.totals);
  const absent = rateProblem(run);
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
      bar(absent ? null : numerator / denominator),
      el(
        'strong',
        { class: 'num' },
        absent ? ABSENT : percent(numerator, denominator),
      ),
      el('span', { class: 'muted num' }, ` (${detail}${notRun})`),
    ),
  };
}

/** Where a rate stops reading as healthy; colour only, never a verdict. */
const tone = (ratio) =>
  ratio >= 0.95 ? 'passing' : ratio >= 0.8 ? 'degraded' : 'failing';

/** A track with a fill; an absent rate is an empty track, never a 0% bar. */
function bar(ratio) {
  const fill = el('span');
  // CSSOM, not a style attribute: a strict style-src CSP allows this.
  if (ratio !== null) fill.style.width = `${Math.floor(ratio * 1000) / 10}%`;
  return el(
    'span',
    {
      class: 'bar',
      'aria-hidden': 'true',
      ...(ratio === null ? {} : { 'data-state': tone(ratio) }),
    },
    fill,
  );
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
      const head = items[0].node.querySelector('strong').textContent;
      return el(
        'section',
        {},
        el(
          'div',
          { class: 'row' },
          el('h3', {}, `${scopeLabel(runs[0].scope)} · ${runs[0].suite}`),
          el('span', { class: 'big', 'aria-hidden': 'true' }, head),
        ),
        el('ol', { class: 'trend' }, ...items.map((i) => i.node)),
      );
    });
    const abstentions = announce(all);
    return { nodes: sections, abstentions };
  }
}
