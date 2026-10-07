// <canary-pipeline-health> -- per suite: passing / failing / cancelled / dark /
// never reported (#1151 phase 3, criterion 10).
//
// "Never reported" needs a declared denominator (D12): with `suites: null`
// the panel says nothing is declared rather than guessing which suites are
// missing. Dark wins over any status: a green run from two weeks ago is not
// evidence the suite is green now.

import { CanaryPanel, el } from '../panel.js';
import {
  ABSENT,
  DARK_AFTER_DAYS,
  ago,
  isDark,
  logicalRuns,
  passCounts,
  rateProblem,
  scopeLabel,
  suiteKey,
  timeProblem,
} from '../model.js';

const BY_STATUS = {
  passed: 'passing',
  failed: 'failing',
  cancelled: 'cancelled',
};

const TIME_STATES = {
  undated: 'no real finish time on its latest run',
  future: 'latest run is dated in the future (clock skew)',
};

export function stateOf(latest, now) {
  if (!latest) return { state: 'never-reported', text: 'never reported' };
  const problem = timeProblem(latest.finished, now);
  if (problem) return { state: problem, text: TIME_STATES[problem] };
  if (isDark(latest.finished, now))
    return {
      state: 'dark',
      text: `dark: no run in ${DARK_AFTER_DAYS} days`,
    };
  // A run missing shards measured part of the suite: never "passing" (#1200).
  if (latest.incomplete)
    return {
      state: 'incomplete',
      text: `incomplete: ${latest.shards.reported} of ${latest.shards.total} shards reported`,
    };
  const state = BY_STATUS[latest.status];
  return { state, text: state };
}

/** Declared suites first, then any suite that reported without being declared. */
export function suiteRows(doc, bySuite) {
  const rows = new Map();
  for (const s of doc.suites ?? [])
    rows.set(suiteKey(s.scope, s.suite), { scope: s.scope, suite: s.suite });
  for (const [key, runs] of bySuite)
    if (!rows.has(key))
      rows.set(key, { scope: runs[0].scope, suite: runs[0].suite });
  return rows;
}

/**
 * "n of m suite(s) passing" over the declared suites, or ABSENT with why. The
 * one source for this panel's line and <canary-summary>'s tile, so the two
 * can never disagree. With nothing declared (null or []) there is no
 * denominator to count against (D12). Red only when a suite is failing: a
 * dark or never-reported suite is unproven, not failed, so it reads grey.
 */
export function suitesPassing(doc, bySuite, now) {
  if (!doc.suites?.length)
    return {
      value: ABSENT,
      why: 'No expected suites are declared, so suites passing has no denominator.',
    };
  const states = [...suiteRows(doc, bySuite).keys()].map(
    (key) => stateOf(bySuite.get(key)?.[0], now).state,
  );
  const passing = states.filter((s) => s === 'passing').length;
  const state =
    passing === states.length
      ? 'passing'
      : states.includes('failing')
        ? 'failing'
        : 'dark';
  return { value: `${passing} of ${states.length}`, state };
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
    const now = this.now();
    const cards = [...rows].map(([key, s]) => {
      const runs = bySuite.get(key) ?? [];
      return { state: stateOf(runs[0], now).state, node: card(s, runs, now) };
    });
    const counted = suitesPassing(doc, bySuite, now);
    // The panel's own abstention already says why there is no line.
    const summary =
      counted.value === ABSENT
        ? null
        : el(
            'p',
            { class: 'summary', 'data-state': counted.state },
            `${counted.value} suite(s) passing`,
          );
    return {
      nodes: [
        summary,
        el('ul', { class: 'cards' }, ...cards.map((c) => c.node)),
      ].filter(Boolean),
      abstentions,
    };
  }

  get bodyClass() {
    return '';
  }
}

/** Oldest to newest, so the strip reads left to right like a timeline. */
const STRIP = 10;

function card(s, runs, now) {
  const latest = runs[0];
  const { state, text } = stateOf(latest, now);
  const last = latest
    ? `last run ${ago(latest.finished, now)} · ${counts(latest)}`
    : 'no run in the feed';
  const shown = runs.slice(0, STRIP).reverse();
  const ticks = shown.map((r) =>
    el('span', {
      'data-state': r.incomplete ? 'incomplete' : r.status,
      title: `${r.id}: ${r.status}`,
    }),
  );
  return el(
    'li',
    { 'data-state': state, class: 'card' },
    el(
      'div',
      { class: 'row' },
      el(
        'span',
        { class: 'name' },
        el('span', { class: 'muted' }, `${scopeLabel(s.scope)} · `),
        s.suite,
      ),
      el('strong', { class: 'pill' }, text),
    ),
    el('div', { class: 'muted num' }, last),
    ticks.length
      ? el(
          'div',
          { class: 'strip', role: 'img', 'aria-label': stripLabel(shown) },
          ...ticks,
        )
      : null,
  );
}

/** "40/40 passed", or "— (why)" when the run has no rate to give. */
function counts(run) {
  const problem = rateProblem(run);
  if (problem) return `${ABSENT} (${problem})`;
  const { numerator, denominator } = passCounts(run.totals);
  return `${numerator}/${denominator} passed`;
}

/** The strip in words: colour and a tooltip reach only some readers. */
function stripLabel(runs) {
  const tally = new Map();
  for (const r of runs) {
    const s = r.incomplete ? 'incomplete' : r.status;
    tally.set(s, (tally.get(s) ?? 0) + 1);
  }
  const parts = ['passed', 'failed', 'cancelled', 'incomplete']
    .filter((s) => tally.has(s))
    .map((s) => `${tally.get(s)} ${s}`)
    .join(', ');
  return `last ${runs.length} runs: ${parts}`;
}
