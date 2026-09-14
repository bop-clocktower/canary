#!/usr/bin/env node
/**
 * Documentation-coverage ratchet (#865).
 *
 * Reads `harness check-docs --json` for the PR head and its merge base and
 * fails only when a file that was documented at the base is still present at
 * the head and no longer documented.
 *
 * Why not a percentage: `--min-coverage 3` was set at the day's measurement
 * and main sat on it with zero slack (5/199 = 2.51%, printed as 3.0%). #864
 * added two undocumented files, making it 5/201 = 2.49%, and failed although
 * it removed nothing. An absolute ratio taxes every new file and says nothing
 * about regressions. Comparing identities against the merge base makes each PR
 * answerable for its own diff, the same move the perf ratchet made in #853.
 * Adding an undocumented file is free, and so is deleting or renaming a
 * documented one: a path absent from the head cannot have lost its doc.
 *
 * What counts as documented is harness's rule, not ours: a markdown link
 * `[..](path)` whose target matches the file's path or basename. A backtick
 * path in a spec does nothing, and nothing in harness's own output says so,
 * so the failure message does.
 *
 * Usage:
 *   harness check-docs --json --min-coverage 0 > head.json || true
 *   node scripts/docs-ratchet.mjs --report head.json [--base-report base.json]
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = verified: no documented file lost its link (or no base: report only)
 *   1 = the ratchet fired: a documented file lost its doc link
 *   3 = ABSTENTION: a report is missing, unparseable, or measured nothing
 */

import { readFileSync } from 'node:fs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function abstain(why) {
  console.error(`docs-ratchet: ABSTAINED: ${why}`);
  process.exit(3);
}

/**
 * Parse a report, tolerating anything npx prints ahead of the JSON body.
 * Returns null when there is no usable `documented`/`undocumented` pair.
 */
function readReport(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const { documented, undocumented } = parsed ?? {};
  if (!Array.isArray(documented) || !Array.isArray(undocumented)) return null;
  return {
    documented: new Set(documented),
    undocumented: new Set(undocumented),
  };
}

const summary = (r) => {
  const total = r.documented.size + r.undocumented.size;
  return `${r.documented.size}/${total} documented`;
};

const headPath = arg('--report');
if (!headPath) abstain('no --report given');
const head = readReport(headPath);
if (!head) abstain(`head report ${headPath} is missing or not check-docs JSON`);
if (head.documented.size + head.undocumented.size === 0) {
  abstain('head report measured zero source files');
}

const basePath = arg('--base-report');
if (!basePath) {
  console.log(
    `docs-ratchet: ${summary(head)} at head; no merge base, report only.`,
  );
  process.exit(0);
}

const base = readReport(basePath);
if (!base) abstain(`base report ${basePath} is missing or not check-docs JSON`);
// An empty documented set on either side is the signature of an instrument
// that stopped seeing links, not of a repo that deleted every doc link in one
// PR. With an empty base every loss is invisible, so the rule would be green
// over nothing; with an empty head every file would read as lost.
if (base.documented.size === 0) abstain('base report documents zero files');
if (head.documented.size === 0) abstain('head report documents zero files');

const lost = [...base.documented].filter((f) => head.undocumented.has(f));
const line = `${summary(head)} at head, ${summary(base)} at merge base`;

if (lost.length === 0) {
  console.log(`docs-ratchet: OK: ${line}; no documented file lost its link.`);
  process.exit(0);
}

console.error(
  `docs-ratchet: FAILED: ${lost.length} file(s) documented at the merge ` +
    `base are no longer documented (${line}):`,
);
for (const f of lost.sort()) console.error(`  - ${f}`);
console.error(
  '\nOnly a markdown link counts as documentation: a `[..](path)` link in ' +
    'any doc whose target is the file (path or basename). A backtick path ' +
    'does not count. Restore the link, or link the file from its spec.',
);
process.exit(1);
