// members -- risk and ties, the two members that answer "what is at stake and
// is it tested" (#666, spec Q1/Q2).
//
// Neither is a new engine. Risk reads the map `canary critical-areas` writes,
// through katana's validated loader. Ties asks katana's own tie predicate
// whether any test file covers a changed source file, so "tied" means exactly
// what it means when katana grades a deletion. Dev-time gap analysis is the
// product of the two: an untied file with high risk is the one to think about.

import { areaContext, loadMapFor } from '../../canary-katana/scripts/areas.mjs';
import { covers } from '../../canary-katana/scripts/ties.mjs';
import { scopeOf } from '../../canary-katana/scripts/testindex.mjs';
import { isolationMember, temporalMember } from './scans.mjs';

/** Where `canary critical-areas` writes the map, relative to the repo. */
export const MAP_REL = '.canary/critical-areas.json';

/** Tests named per tied file in a row; `test_count` carries the total. */
const TESTS_PER_ROW = 5;

const notChecked = (reason) => ({
  status: 'not-checked',
  checked: 0,
  reason,
  rows: [],
});

const sourcesOf = ({ files }) =>
  files.filter((f) => f.kind === 'source').map((f) => f.path);

/** The critical-areas map, or why it is unavailable. Never throws. */
export function loadMap(root) {
  let found = false;
  const map = loadMapFor(root, null, () => {
    found = true;
  });
  if (found)
    return map.available ? map : { available: false, reason: map.reason };
  return {
    available: false,
    reason: `no map at ${MAP_REL}; run canary critical-areas to create it`,
  };
}

/** Usable areas by path; an area with contract problems is left out. */
function areasByPath(map) {
  const byPath = new Map();
  map.areas.forEach((area, i) => {
    if (!map.problems?.has(i)) byPath.set(area.path, area);
  });
  return byPath;
}

/** The map, loaded once per run and shared by both members. */
function mapOf(ctx) {
  ctx.map ??= loadMap(ctx.root);
  return ctx.map;
}

export const riskMember = {
  name: 'risk',
  skill: 'canary-critical-areas',
  run(ctx) {
    const sources = sourcesOf(ctx);
    if (!sources.length) return notChecked('no source file in the target');
    const map = mapOf(ctx);
    if (!map.available) return notChecked(map.reason);
    const areas = areasByPath(map);
    const rows = sources
      .filter((p) => areas.has(p))
      .map((p) => ({ path: p, risk_score: Number(areas.get(p).risk_score) }))
      .sort((a, b) => b.risk_score - a.risk_score);
    return { status: 'ran', checked: sources.length, reason: null, rows };
  },
};

/** One ties row: which indexed tests cover `rel`, by katana's rules. */
function tieRow(rel, index, areas) {
  const ctx = areaContext(areas.get(rel) ?? { path: rel }, null);
  const tests = index.filter((e) => covers(e, ctx)).map((e) => e.rel);
  return {
    path: rel,
    tied: tests.length > 0,
    tests: tests.slice(0, TESTS_PER_ROW),
    test_count: tests.length,
  };
}

export const tiesMember = {
  name: 'ties',
  skill: 'canary-katana',
  run(ctx) {
    const sources = sourcesOf(ctx);
    if (!sources.length) return notChecked('no source file in the target');
    const map = mapOf(ctx);
    const areas = map.available ? areasByPath(map) : new Map();
    const index = scopeOf(ctx.root, '').index();
    const rows = sources
      .map((rel) => tieRow(rel, index, areas))
      .sort((a, b) => Number(a.tied) - Number(b.tied));
    return {
      status: 'ran',
      checked: sources.length,
      reason: null,
      detail: `${index.length} test file(s) indexed`,
      rows,
    };
  },
};

/** Cheapest first, so a spent budget drops the most expensive member. */
export const MEMBERS = [
  riskMember,
  isolationMember,
  temporalMember,
  tiesMember,
];
