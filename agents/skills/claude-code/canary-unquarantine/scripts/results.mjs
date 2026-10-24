// results -- what the trial run said about each lifted test.
//
// Reads a Playwright JSON reporter document (the shape `--reporter=json`
// writes: suites -> specs -> tests -> results) or a JUnit XML file (pytest's
// `--junitxml`, and most other runners), and reduces it to one outcome per
// test case:
//
//   pass    every attempt that counted passed
//   fail    it failed (Playwright `unexpected`, JUnit <failure>/<error>)
//   flaky   it failed and then passed on retry (Playwright `flaky`)
//   skipped it did not run -- still switched off by something else
//
// A row is judged from the cases that belong to it: the test itself, or for a
// lifted describe every case under it. A row with no case in the run is
// `missing`, and missing is never a pass.

import fs from 'node:fs';
import path from 'node:path';

import { scratchDir } from './git.mjs';

/** @typedef {{file: string, titlePath: string[], outcome: string}} Case */

// Null-prototype, so a status named like an Object.prototype key is not an outcome.
const PW_OUTCOME = Object.assign(Object.create(null), {
  expected: 'pass',
  unexpected: 'fail',
  flaky: 'flaky',
  skipped: 'skipped',
});

/** One Playwright test's outcome; an unknown status falls back to its attempts. */
function pwOutcome(t) {
  if (PW_OUTCOME[t.status]) return PW_OUTCOME[t.status];
  return (t.results ?? []).some((r) => r.status === 'passed') ? 'pass' : 'fail';
}

/** The cases one Playwright spec contributes. */
function specCases(spec, titles, file) {
  const where = spec.file ?? file ?? '';
  return (spec.tests ?? []).map((t) => ({
    file: where,
    titlePath: [...titles, spec.title],
    outcome: pwOutcome(t),
  }));
}

/** A suite and everything under it. The file-level suite's title is its path, not a describe. */
function suiteCases(suite, trail, file) {
  const here = suite.file ?? file;
  const titles =
    suite.title && suite.title !== here ? [...trail, suite.title] : trail;
  const own = (suite.specs ?? []).flatMap((spec) =>
    specCases(spec, titles, here),
  );
  const nested = (suite.suites ?? []).flatMap((child) =>
    suiteCases(child, titles, here),
  );
  return [...own, ...nested];
}

/**
 * Flatten a Playwright JSON report into cases.
 * @returns {Case[]}
 */
export function playwrightCases(doc) {
  return (doc.suites ?? []).flatMap((s) => suiteCases(s, [], s.file));
}

const ENTITIES = {
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};
const decode = (s) =>
  s.replace(/&(?:quot|apos|lt|gt|amp);/g, (e) => ENTITIES[e]);
const attr = (tag, name) =>
  decode(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '');

/**
 * A JUnit case's outcome. A case that failed and then passed on retry carries
 * surefire's <flakyFailure>/<flakyError> or pytest-rerunfailures' <rerun>
 * (also <rerunFailure>/<rerunError>) and no <failure>: that is a flake, and a
 * retry pass is not a fix.
 */
function junitOutcome(body) {
  if (/<(?:failure|error)\b/.test(body)) return 'fail';
  if (/<(?:flaky|rerun)(?:Failure|Error)?\b/.test(body)) return 'flaky';
  return /<skipped\b/.test(body) ? 'skipped' : 'pass';
}

/**
 * Flatten a JUnit XML document into cases.
 * @returns {Case[]}
 */
export function junitCases(xml) {
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  return [...xml.matchAll(re)].map((m) => {
    const classname = attr(m[1], 'classname');
    return {
      file: attr(m[1], 'file') || classname.replace(/\./g, '/'),
      titlePath: [classname, attr(m[1], 'name')].filter(Boolean),
      outcome: junitOutcome(m[3] ?? ''),
    };
  });
}

/** The cases in one document, or null when it is not a results document. */
function documentCases(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.xml'))
    return text.includes('<testcase') ? junitCases(text) : null;
  try {
    const doc = JSON.parse(text);
    return Array.isArray(doc?.suites) ? playwrightCases(doc) : null;
  } catch {
    return null;
  }
}

/** Read every result document under `p` (a file or a directory). */
export function readCases(p) {
  const files = fs.statSync(p).isDirectory()
    ? fs.readdirSync(p, { recursive: true }).map((f) => path.join(p, String(f)))
    : [p];
  const cases = [];
  const read = [];
  for (const f of files.filter((x) => /\.(json|xml)$/.test(x))) {
    const found = documentCases(f);
    if (!found) continue;
    cases.push(...found);
    read.push(f);
  }
  return { cases, read };
}

const norm = (p) =>
  String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\.py$/, '');
const sameFile = (a, b) => {
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
};

/** The worst outcome among a row's cases: a fail outranks a flake outranks a skip. */
function worst(cases) {
  for (const o of ['fail', 'flaky', 'skipped'])
    if (cases.some((c) => c.outcome === o)) return o;
  return 'pass';
}

/**
 * The outcome for one lifted row: the cases in its file whose title path
 * holds its title as a whole segment. When none does, cases whose title merely
 * CONTAINS it (the ledger's looser matching rule) may only demote: a failing,
 * flaky or skipped look-alike keeps the row quarantined, but a passing one is
 * a sibling (`adds item twice` for a lifted `adds item`), not proof the lifted
 * test ran, so the row is `missing`.
 *
 * @returns {{outcome: string, cases: number}} pass, fail, flaky, skipped or missing
 */
export function judge(row, cases) {
  const inFile = cases.filter((c) => sameFile(c.file, row.file));
  const exact = inFile.filter((c) => c.titlePath.includes(row.test));
  if (exact.length) return { outcome: worst(exact), cases: exact.length };
  const near = inFile.filter((c) =>
    c.titlePath.some((t) => t.includes(row.test)),
  );
  const outcome = near.length ? worst(near) : 'pass';
  if (outcome === 'pass') return { outcome: 'missing', cases: 0 };
  return { outcome, cases: near.length };
}

/**
 * Fetch the trial run's result files: the newest COMPLETED run on the trial
 * commit, artifact `artifact`. Returns { dir } or { why } -- a run still in
 * progress, or one that uploaded no such artifact, is an abstention.
 */
export function downloadResults(
  run,
  { repo, headRefName, headRefOid, artifact },
) {
  const fields = 'databaseId,headSha,status,conclusion';
  const list = run(
    'gh',
    ['run', 'list', '--branch', headRefName, '--json', fields, '--limit', '20'],
    { cwd: repo },
  );
  if (list.status !== 0)
    return { why: `gh run list failed: ${(list.stderr || '').trim()}` };
  let listed;
  try {
    listed = JSON.parse(list.stdout || '[]');
  } catch (exc) {
    return { why: `gh run list returned unparseable JSON: ${exc.message}` };
  }
  if (!Array.isArray(listed))
    return { why: 'gh run list returned JSON that is not a list of runs' };
  const runs = listed.filter((r) => r.headSha === headRefOid);
  const sha = headRefOid.slice(0, 7);
  if (!runs.length) return { why: `no CI run on the trial commit ${sha} yet` };
  const done = runs.find((r) => r.status === 'completed');
  if (!done) return { why: `CI on the trial commit ${sha} has not finished` };
  const dir = scratchDir('unquarantine-results-');
  const dl = run(
    'gh',
    ['run', 'download', String(done.databaseId), '-n', artifact, '-D', dir],
    { cwd: repo },
  );
  if (dl.status !== 0)
    return {
      why: `run ${done.databaseId} has no artifact "${artifact}": ${(dl.stderr || '').trim()}`,
    };
  return { dir };
}
