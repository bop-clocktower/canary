// <canary-summary> -- a row of count tiles over the feed: suites passing,
// failed tests in each suite's latest run, distinct flaky tests, and the
// skipped/removed register.
//
// Counts only. A cross-suite pass rate would be the averaged "overall" number
// ADR 0036 rules out, so there is none. Each tile abstains on the same terms
// as the panel it summarizes: "—" plus the reason, never a 0 nothing measured.

import { CanaryPanel, el } from '../panel.js';
import { ABSENT, logicalRuns, rateProblem, registerUnread } from '../model.js';
import { stateOf, suitesPassing, suiteRows } from './pipeline-health.js';

/** Suite keys to count: declared ones plus any that reported anyway. */
const suiteKeys = (doc, bySuite) => [...suiteRows(doc, bySuite).keys()];

/**
 * A suite's latest run counts toward failed tests only when it is recent,
 * dated, complete and actually counted tests: the runs pipeline health calls
 * passing or failing. Anything else measured nothing usable, so summing it in
 * would turn "not measured" into a 0.
 */
function measured(run, now) {
  if (!run || rateProblem(run)) return false;
  return ['passing', 'failing'].includes(stateOf(run, now).state);
}

/** Why a suite's latest run is left out of failed tests, in a few words. */
function leftOut(run, now) {
  if (!run) return 'never reported';
  if (run.incomplete) return 'missing shards';
  if (rateProblem(run)) return 'no tests counted';
  return stateOf(run, now).state;
}

function failed(doc, bySuite, now) {
  const latest = suiteKeys(doc, bySuite).map((k) => bySuite.get(k)?.[0]);
  const runs = latest.filter((r) => measured(r, now));
  const reasons = new Map();
  for (const r of latest.filter((r) => !measured(r, now))) {
    const why = leftOut(r, now);
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
  const left = latest.length - runs.length;
  const detail = [...reasons].map(([why, n]) => `${n} ${why}`).join(', ');
  const why = left
    ? `${left} suite(s) not counted in failed tests (${detail}).`
    : undefined;
  if (runs.length === 0) return { value: ABSENT, why };
  const n = runs.reduce((s, r) => s + r.totals.failed + r.totals.timed_out, 0);
  // A count over part of the suites is never green: red is real, 0 is partial.
  const state = n ? 'failing' : left ? undefined : 'passing';
  return { value: String(n), state, why };
}

function flaky(doc) {
  if (doc.flaky.length === 0 && doc.runs.every((r) => r.results === null))
    return {
      value: ABSENT,
      why: 'No run carries per-test results, so flakiness was not measured.',
    };
  const n = doc.flaky.length;
  return { value: String(n), state: n ? 'degraded' : 'passing' };
}

function register(doc) {
  const n = doc.register.length;
  // An empty register beside starling's not-assessed marker was never read
  // (#1199); without the marker, 0 is a real count.
  const unread = n === 0 ? registerUnread(doc) : null;
  if (unread)
    return { value: ABSENT, why: `Register not assessed: ${unread}.` };
  return { value: String(n), state: n ? 'degraded' : 'passing' };
}

const TILES = [
  ['suites', 'Suites passing'],
  ['failed', 'Failed tests'],
  ['flaky', 'Flaky tests'],
  ['register', 'Skipped & removed'],
];

export class Summary extends CanaryPanel {
  get heading() {
    return 'Summary';
  }

  get bodyClass() {
    return '';
  }

  build(doc) {
    if (doc.runs.length === 0)
      return {
        nodes: [],
        abstentions: ['No runs in the feed, so there is nothing to sum up.'],
      };
    const bySuite = logicalRuns(doc.runs);
    const now = this.now();
    const found = {
      suites: suitesPassing(doc, bySuite, now),
      failed: failed(doc, bySuite, now),
      flaky: flaky(doc),
      register: register(doc),
    };
    const items = TILES.map(([key, label]) => {
      const { value, state } = found[key];
      return el(
        'li',
        {
          'data-tile': key,
          class: 'card',
          ...(state ? { 'data-state': state } : {}),
        },
        el('span', { class: 'label' }, label),
        el('strong', {}, value),
      );
    });
    return {
      nodes: [el('ul', { class: 'stats' }, ...items)],
      abstentions: Object.values(found)
        .map((t) => t.why)
        .filter(Boolean),
    };
  }
}
