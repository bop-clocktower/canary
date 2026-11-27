// scans -- the two static test-file scanners, run on the changed tests only
// (#666, spec Q1). Both are Tier-0 and file-scoped, which is what makes them
// cheap enough for the middle of a change. Savant's --confirm pass runs the
// suite and is deliberately not a member.

import path from 'node:path';

import { scanPaths as savantScan } from '../../canary-savant/scripts/scanner.mjs';
import { scanPaths as blackhawkScan } from '../../canary-blackhawk/scripts/scanner.mjs';

/** Findings in the scanners' JSON-contract shape, with repo-relative paths. */
function toRows(root, findings) {
  return findings.map((f) => ({
    file: path.relative(root, f.file).split(path.sep).join('/'),
    line: f.line,
    rule_id: f.ruleId,
    severity: f.severity,
    why: f.why,
  }));
}

function scanMember(name, skill, scan) {
  return {
    name,
    skill,
    run({ root, files }) {
      const tests = files.filter((f) => f.kind === 'test');
      if (!tests.length) {
        return {
          status: 'not-checked',
          checked: 0,
          reason: 'no test file in the target',
          rows: [],
        };
      }
      const result = scan(tests.map((f) => path.join(root, f.path)));
      return {
        status: 'ran',
        checked: result.filesScanned,
        reason: null,
        rows: toRows(root, result.findings),
      };
    },
  };
}

export const isolationMember = scanMember(
  'isolation',
  'canary-savant',
  savantScan,
);

export const temporalMember = scanMember(
  'temporal',
  'canary-blackhawk',
  blackhawkScan,
);
