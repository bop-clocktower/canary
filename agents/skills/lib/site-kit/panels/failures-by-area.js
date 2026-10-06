// <canary-failures-by-area> -- the latest run of each suite, broken down by
// area (#1151 phase 3, plan P1/P1a). Failed, quarantined (in the katana
// register) and not-run are separate columns, so a quarantine is never read
// as a failure or as a pass. A null area is a visible "(unassigned)" row.

import { CanaryPanel, el } from '../panel.js';
import { logicalRuns } from '../model.js';

const FAILED = ['failed', 'timed_out'];
const NOT_RUN = ['skipped', 'interrupted'];
const UNASSIGNED = '(unassigned)';

const testKey = (scope, file, title) =>
  [scope.id, scope.env, file, title].join('\u0000');

function bucketOf(test, scope, quarantined) {
  const failed = FAILED.includes(test.status);
  if (!failed && !NOT_RUN.includes(test.status)) return null;
  if (quarantined.has(testKey(scope, test.file, test.title)))
    return 'quarantined';
  return failed ? 'failed' : 'notRun';
}

function tally(latest, quarantined) {
  const areas = new Map();
  for (const run of latest)
    for (const test of run.results) {
      const bucket = bucketOf(test, run.scope, quarantined);
      if (!bucket) continue;
      const area = test.area ?? UNASSIGNED;
      const row = areas.get(area) ?? {
        failed: 0,
        quarantined: 0,
        notRun: 0,
      };
      row[bucket] += 1;
      areas.set(area, row);
    }
  return areas;
}

function tableOf(areas) {
  const rows = [...areas]
    .sort(([a, x], [b, y]) => y.failed - x.failed || a.localeCompare(b))
    .map(([area, r]) =>
      el(
        'tr',
        {},
        el('td', {}, area),
        el('td', {}, String(r.failed)),
        el('td', {}, String(r.quarantined)),
        el('td', {}, String(r.notRun)),
      ),
    );
  const head = ['Area', 'Failed', 'Quarantined', 'Not run'].map((h) =>
    el('th', { scope: 'col' }, h),
  );
  return el(
    'table',
    {},
    el('thead', {}, el('tr', {}, ...head)),
    el('tbody', {}, ...rows),
  );
}

export class FailuresByArea extends CanaryPanel {
  get heading() {
    return 'Failures by area';
  }

  build(doc) {
    const latest = [...logicalRuns(doc.runs).values()].map((runs) => runs[0]);
    if (latest.length === 0)
      return { nodes: [], abstentions: ['No runs in the feed.'] };
    const carried = latest.filter((r) => r.results !== null);
    const blind = latest.length - carried.length;
    const abstentions = blind
      ? [
          `${blind} suite(s) carry no per-test results in their latest run, so their failures cannot be broken down.`,
        ]
      : [];
    if (carried.length === 0) return { nodes: [], abstentions };
    const quarantined = new Set(
      doc.register.map((r) => testKey(r.scope, r.file, r.title)),
    );
    const areas = tally(carried, quarantined);
    const nodes = areas.size
      ? [tableOf(areas)]
      : [
          el(
            'p',
            {},
            `No failed, quarantined or not-run tests in the latest run of ${carried.length} suite(s).`,
          ),
        ];
    return { nodes, abstentions };
  }
}
