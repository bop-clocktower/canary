// verdict -- read the trial run, test by test.
//
// Per lifted test, from the suite's own CI result for the trial commit:
//
//   pass     every case for it passed
//   fail     a case failed
//   flaky    a case failed and passed on retry
//   missing  / skipped: the run did not exercise it
//
// Never on ticket state, never on the run's overall conclusion: a green run
// in which a lifted test did not appear is not a pass for that test.
// `settle` turns these outcomes into the trial PR's final shape.

import { readManifest } from './lift.mjs';
import { judge, readCases } from './results.mjs';

/** The trial PR: its manifest and head. Throws when no trial opened it. */
export function loadTrial(run, pr, repo) {
  const r = run(
    'gh',
    [
      'pr',
      'view',
      String(pr),
      '--json',
      'body,headRefName,headRefOid,url,state',
    ],
    { cwd: repo },
  );
  if (r.status !== 0)
    throw new Error(
      `gh pr view ${pr} failed (exit ${r.status}): ${(r.stderr || '').trim()}`,
    );
  const doc = JSON.parse(r.stdout);
  const manifest = readManifest(doc.body);
  if (!manifest)
    throw new Error(
      `PR ${pr} carries no canary-unquarantine-trial manifest; it was not opened by \`trial\``,
    );
  return { ...doc, manifest };
}

/**
 * Judge every lift in `trial` against the result documents at `source`.
 * Returns { judged, documents, cases } or { abstain } when the documents hold
 * no test case at all -- a run nobody can read proves nothing.
 */
export function planVerdict(trial, source) {
  const { cases, read } = readCases(source);
  if (!cases.length)
    return {
      abstain: `no test cases in ${read.length} result document(s) at ${source}`,
    };
  const judged = trial.manifest.lifts.map((l) => ({
    ...l,
    ...judge(l, cases),
  }));
  return { judged, documents: read.length, cases: cases.length };
}
