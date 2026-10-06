// inputs -- every file canary-starling reads, as run, assessment and register
// records ready to compose.
//
// Split from feed.mjs so no module couples to more than four others (perf
// coupling ratio): this one reads, feed.mjs derives and composes. Each input
// it could not use is pushed onto `notes` for the CLI to name on stderr.

import fs from 'node:fs';

import { validateDocument } from '../../../lib/contracts/document.mjs';
import { historyRuns, selectRuns } from './runs.mjs';
import { ledgerRegister } from './register.mjs';

/** @throws naming the file, on one that is unreadable or not JSON */
export function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (exc) {
    throw new Error(`cannot read ${what} ${file}: ${exc.message}`);
  }
}

/** Each RECORD file must itself be a valid run or assessment record. */
function readRecord(file) {
  // One read, one parse: the document validated is the document returned.
  const doc = readJson(file, 'record');
  const { valid, contract, errors } = validateDocument(doc);
  if (!valid)
    throw new Error(
      `${file}: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
    );
  if (contract !== 'canary.run/1' && contract !== 'canary.assessment/1')
    throw new Error(
      `${file}: expected a run or assessment record, got ${contract}`,
    );
  return doc;
}

const isRun = (r) => r.contract === 'canary.run/1';

/**
 * Reads the RECORD files, the history store, the ledger and the ci-ready
 * report. `window` is every selected run with its results (flaky[] needs
 * them); `feed` is what the site carries. `report` is null when none was named.
 * @throws on an unreadable or invalid RECORD file, store or report
 */
export function readInputs(args, scope, notes) {
  const records = (args.records ?? []).map(readRecord);
  const runs = records.filter(isRun);
  if (args.history) runs.push(...historyRuns(args.history, scope, notes));
  const { window, feed } = selectRuns(runs);
  return {
    assessments: records.filter((r) => !isRun(r)),
    window,
    feed,
    register: ledgerRegister(args.ledger, scope, notes),
    report: args.ciReady ? readJson(args.ciReady, 'ci-ready report') : null,
  };
}
