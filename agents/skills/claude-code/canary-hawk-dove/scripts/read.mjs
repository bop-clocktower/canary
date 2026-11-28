// read -- `report`: print the per-gate outcome counts and choose the exit
// code (#618). Findings never set the exit: only an abstention (3), an
// unusable ledger (2) or a failed --out write (1) does.

import { loadLedger } from './ledger.mjs';
import { ABSTAINED_LINE, buildReport, renderMarkdown } from './report.mjs';
import { writeOut } from './files.mjs';
import { clean } from './escape.mjs';

const PREFIX = 'canary-hawk-dove:';
const EXIT_WRITE = 1;
const EXIT_UNREADABLE = 2;
const EXIT_ABSTAINED = 3;

/** `report [--json] [--out PATH]` */
export function report(opts) {
  if (opts.args.length > 1) return { usage: 'report: takes no arguments' };
  const led = loadLedger(opts.repo, opts.ledger);
  if (led.notRead) {
    console.error(`${PREFIX} ledger not read: ${clean(led.notRead)}`);
    return { code: EXIT_UNREADABLE };
  }
  const result = buildReport(led.state, { malformed: led.malformed });
  if (led.missing) {
    result.reason = `no ledger at ${opts.ledger}; run record first`;
  }
  const text = opts.json
    ? JSON.stringify(result, null, 2)
    : renderMarkdown(result);
  console.log(text);
  // Mirrored to stderr: a report redirected to a file must still say, where a
  // person will see it, that it measured nothing worth a number.
  if (result.abstained) {
    console.error(`${PREFIX} ${ABSTAINED_LINE} ${clean(result.reason, 300)}`);
  }
  const failure = opts.out ? writeOut(opts.out, text) : null;
  if (failure) {
    console.error(`${PREFIX} ${clean(failure, 400)}`);
    return { code: EXIT_WRITE };
  }
  return { code: result.abstained ? EXIT_ABSTAINED : 0 };
}
