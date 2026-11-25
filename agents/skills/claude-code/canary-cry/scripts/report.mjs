// canary-cry report -- Tier-0 (#608 P5; spec "Outputs (scripts/report.mjs)").
// `cry report <run-id>` reads a run dir's findings.json and writes report.md
// (its text and ranking are report-text.mjs): every verdict ranked
// corrupted, symptom, clean, abstain, then by score, each with the standalone
// replay command of its own spec. Deterministic, no network, no agent: it is
// in the static closure of cli.mjs (SC6), and the same findings.json always
// gives byte-identical output.
//
// It trusts nothing it reads back. The run-id is checked against the run-id
// shape BEFORE it becomes a path, and every scenario's replay command is
// DERIVED from its id (checked against the scenario-id shape), never copied
// from the file: a tampered `repro.spec` such as `$(...)` is a damaged
// findings.json (exit 2), not a command an operator pastes into a shell.

import fs from 'node:fs';
import path from 'node:path';

import { isRunId } from './checkpoint.mjs';
import { reportOf, specOf } from './report-text.mjs';

const FINDINGS_FORMAT = 'canary.cry-findings/1';
const VERDICTS = new Set(['corrupted', 'symptom', 'clean', 'abstain']);
const STATUSES = new Set(['ok', 'abstained', 'partial']);
/** `<flow>:<pattern>:i<n>:s<step>`, each part an ID_RE id. */
const SCENARIO_ID =
  /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*:i\d:s[a-z0-9][a-z0-9-]*$/;
const isObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const DOC_CHECKS = [
  ['format', (d) => d.format === FINDINGS_FORMAT, `not ${FINDINGS_FORMAT}`],
  ['status', (d) => STATUSES.has(d.status), 'not ok, abstained or partial'],
  ['run', (d) => isObject(d.run), 'not an object'],
  ['scenarios', (d) => Array.isArray(d.scenarios), 'not a list'],
  ['blockedEgress', (d) => Array.isArray(d.blockedEgress), 'not a list'],
];

const SCENARIO_CHECKS = [
  ['id', (s) => SCENARIO_ID.test(s.id), 'not a scenario id'],
  ['verdict', (s) => VERDICTS.has(s.verdict), 'not a verdict'],
  ['score', (s) => Number.isFinite(s.score), 'not a number'],
  ['repro.spec', (s) => s.repro?.spec === specOf(s.id), 'not its own spec'],
  ['fingerprints', (s) => Array.isArray(s.fingerprints), 'not a list'],
  ['invariants', (s) => Array.isArray(s.invariants), 'not a list'],
];

const firstFailure = (checks, value, at) => {
  const bad = checks.find(([, ok]) => !ok(value));
  return bad ? `${at}.${bad[0]}: ${bad[2]}` : null;
};

/** Why `doc` is not a findings.json of run `runId`, or null. */
function findingsError(doc, runId) {
  if (!isObject(doc)) return '$: not an object';
  const docError = firstFailure(DOC_CHECKS, doc, '$');
  if (docError !== null) return docError;
  if (doc.run.id !== runId) return '$.run.id: not this run';
  for (const [i, s] of doc.scenarios.entries()) {
    const at = `$.scenarios[${i}]`;
    if (!isObject(s)) return `${at}: not an object`;
    const error = firstFailure(SCENARIO_CHECKS, s, at);
    if (error !== null) return error;
  }
  return null;
}

/** `{error}` (exit 2), or the run dir and its trusted findings.json. */
function loadFindings(flowsFile, runId) {
  if (runId === undefined) return { error: 'report: RUN_ID is required' };
  const unknown = { error: `report: unknown run-id: ${runId}` };
  if (!isRunId(runId)) return unknown;
  const dir = path.join(path.dirname(flowsFile), 'runs', runId);
  if (!fs.existsSync(dir)) return unknown;
  const file = path.join(dir, 'findings.json');
  if (!fs.existsSync(file)) {
    return {
      error:
        `run ${runId} has no findings.json: it was planned and never ` +
        'confirmed, or it stopped before writing one',
    };
  }
  const damaged = (why) => ({
    error: `run ${runId}: findings.json is damaged: ${why}`,
  });
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return damaged('not valid JSON');
  }
  const why = findingsError(doc, runId);
  return why === null ? { error: null, dir, doc } : damaged(why);
}

/**
 * `cry report <run-id> [--json] [--strict]`: writes report.md into the run
 * dir and returns what to print, or `{errors}` (exit 2).
 * @param {{flows: string, json: boolean, strict: boolean}} opts
 * @param {string | undefined} runId
 * @returns {{errors: string[]} | {errors: null, text: string, exit: number}}
 */
export function runReport(opts, runId) {
  const loaded = loadFindings(opts.flows, runId);
  if (loaded.error !== null) return { errors: [loaded.error] };
  const file = path.join(loaded.dir, 'report.md');
  const { report, md, exit } = reportOf(loaded.doc, {
    dir: loaded.dir,
    file,
    strict: opts.strict,
  });
  fs.writeFileSync(file, md);
  const text = opts.json ? JSON.stringify(report, null, 2) : md.trimEnd();
  return { errors: null, text, exit };
}
