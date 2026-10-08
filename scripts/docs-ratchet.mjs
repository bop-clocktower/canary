#!/usr/bin/env node
/**
 * Documentation-coverage ratchet (#865, #1241).
 *
 * Reads `harness check-docs --json` and applies two rules. Either can fail, the
 * same "two rules, not one" shape as `entropy-ratchet.mjs` (#703).
 *
 * 1. IDENTITY (#865), on pull requests: fail when a file that was documented at
 *    the merge base is still present at the head and no longer documented.
 *
 *    Why not only a percentage: `--min-coverage 3` was set at the day's
 *    measurement and main sat on it with zero slack (5/199 = 2.51%, printed as
 *    3.0%). #864 added two undocumented files, making it 5/201 = 2.49%, and
 *    failed although it removed nothing. Comparing identities against the
 *    merge base makes each PR answerable for its own diff. Adding an
 *    undocumented file is free, and so is deleting or renaming a documented
 *    one: a path absent from the head cannot have lost its doc.
 *
 * 2. FLOOR (#1241), on every run: fail when coverage falls below
 *    `minCoveragePercent` in `.harness/docs-coverage-baseline.json`.
 *
 *    The identity rule cannot see dilution. A run of PRs that each add only
 *    undocumented files is green under it forever while coverage walks down,
 *    so the floor is the backstop. It keeps `maxHeadroom` points of deliberate
 *    slack below the measurement, as the entropy and perf ceilings do, so one
 *    undocumented file does not replay #864. It never moves on its own:
 *    raising it is a reviewed edit to the baseline (a restamp), and this
 *    script prints the values to write once coverage outgrows the headroom.
 *
 *    Coverage is the exact ratio of the two file lists. harness's own
 *    `coveragePercent` is `Math.round`ed to an integer, so 17.95% reads as
 *    "18" and 49.6% would clear a 50 floor.
 *
 * What counts as documented is harness's rule, not ours: a markdown link
 * `[..](path)` in a `.md` file UNDER `docsDir` (`./docs`) whose target matches
 * the file's repo-relative path or its basename. A backtick path does nothing,
 * and neither does a link from AGENTS.md or README.md at the repo root, because
 * those files are outside `docsDir`. Nothing in harness's own output says so,
 * so the failure messages do.
 *
 * Usage:
 *   harness check-docs --json --min-coverage 0 > head.json || true
 *   node scripts/docs-ratchet.mjs --report head.json \
 *     [--base-report base.json] [--cli-version 12.10.1] [--baseline file]
 *
 * Exit codes follow the repo's gate convention (ADR 0009):
 *   0 = verified: at or above the floor, and no documented file lost its link
 *   1 = the ratchet fired: below the floor, or a documented file lost its link
 *   2 = usage: no --report, or the baseline is missing or has no numeric floor
 *   3 = ABSTENTION: a report is missing, unparseable, or measured nothing, or
 *       it came from a different harness CLI than the floor was measured with
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(
  REPO_ROOT,
  '.harness',
  'docs-coverage-baseline.json',
);

/** Slack below the measurement when the baseline does not declare its own. */
const DEFAULT_MAX_HEADROOM = 1;

const LINK_RULE =
  'Only a markdown link counts as documentation: a `[..](path)` link in a ' +
  '.md file under docs/ whose target is the file (path or basename). A ' +
  'backtick path does not count, and neither does a link from AGENTS.md or ' +
  'README.md, which sit outside docs/.';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function usage(why) {
  console.error(`docs-ratchet: ${why}`);
  process.exit(2);
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
  const { documented, undocumented, scannedNothing } = parsed ?? {};
  if (!Array.isArray(documented) || !Array.isArray(undocumented)) return null;
  return {
    documented: new Set(documented),
    undocumented: new Set(undocumented),
    scannedNothing: scannedNothing === true,
  };
}

const total = (r) => r.documented.size + r.undocumented.size;
const percent = (r) => (r.documented.size / total(r)) * 100;
const fmt = (n) => `${n.toFixed(2)}%`;
const summary = (r) => `${r.documented.size}/${total(r)} documented`;

/** Read the floor, its headroom and its instrument, or exit 2. */
function readBaseline(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    usage(`cannot read baseline ${path}: ${err.message}`);
  }
  const floor = parsed?.minCoveragePercent;
  if (typeof floor !== 'number' || !Number.isFinite(floor)) {
    usage(`${path} has no numeric "minCoveragePercent".`);
  }
  return {
    floor,
    // The baseline owns its headroom, so the script and the offline guards in
    // `ts/test/docs-ratchet.test.ts` cannot drift to two values.
    maxHeadroom:
      typeof parsed.maxHeadroom === 'number'
        ? parsed.maxHeadroom
        : DEFAULT_MAX_HEADROOM,
    baselineCli:
      typeof parsed.harnessCli === 'string' ? parsed.harnessCli : null,
  };
}

/**
 * Abstain unless the CLI that produced this report is the one the floor was
 * measured with (#744). The workflows pin a floating major, so the scanner
 * behind this ratio can change with no commit here, in either direction.
 */
function requireMatchingInstrument(baselineCli, cliVersion, path) {
  if (baselineCli === null || cliVersion === baselineCli) return;
  abstain(
    `the floor in ${path} was measured with harness CLI ${baselineCli}, but ` +
      (cliVersion === null
        ? 'the caller did not say which version produced this report ' +
          '(pass `--cli-version`).'
        : `this report was produced by ${cliVersion}.`) +
      '\nThe ratio is not comparable to the floor. Re-measure in a clean ' +
      'worktree and update "harnessCli" and the measured fields in the SAME ' +
      'PR. Do not silence this by deleting "harnessCli".',
  );
}

/** Rule 1: no file documented at the merge base lost its link. */
function requireNoLostLinks(head, basePath) {
  const base = readReport(basePath);
  if (!base)
    abstain(`base report ${basePath} is missing or not check-docs JSON`);
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
    return true;
  }
  console.error(
    `docs-ratchet: FAILED: ${lost.length} file(s) documented at the merge ` +
      `base are no longer documented (${line}):`,
  );
  for (const f of lost.sort()) console.error(`  - ${f}`);
  console.error(
    `\n${LINK_RULE} Restore the link, or link the file from its spec.`,
  );
  return false;
}

/** Rule 2: coverage is at or above the floor. Nudges a restamp, never fails on it. */
function requireFloor(head, { floor, maxHeadroom }, path) {
  const pct = percent(head);
  if (pct < floor) {
    console.error(
      `docs-ratchet: FAILED (floor): coverage is ${fmt(pct)} ` +
        `(${summary(head)}), below the ${fmt(floor)} floor in ${path}.\n` +
        `${LINK_RULE}\nLink the new files from docs/. Lowering ` +
        '"minCoveragePercent" to make this pass is the one move that is ' +
        'never the right one.',
    );
    return false;
  }
  console.log(
    `docs-ratchet: OK (floor): coverage ${fmt(pct)} (${summary(head)}), ` +
      `floor ${fmt(floor)}.`,
  );
  if (pct - floor > maxHeadroom) {
    // Rounded UP to 2 decimals so the restamped gap is within the headroom.
    const next = Math.ceil((pct - maxHeadroom) * 100) / 100;
    console.log(
      `docs-ratchet: coverage is ${(pct - floor).toFixed(2)} points above the ` +
        `floor, more than the ${maxHeadroom} of headroom. Please restamp ` +
        `${path} so the gate keeps its teeth: "minCoveragePercent": ${next}, ` +
        `"measuredPercent": ${Number(pct.toFixed(2))}, "measuredDocumented": ` +
        `${head.documented.size}, "measuredScanned": ${total(head)}.`,
    );
  }
  return true;
}

function main() {
  const headPath = arg('--report');
  if (!headPath) usage('--report <file> is required.');
  const baselinePath = arg('--baseline') ?? DEFAULT_BASELINE;
  const baseline = readBaseline(baselinePath);

  // Zero-denominator rule: a report that checked nothing abstains. It is never
  // a pass and never a 0% failure, because nothing was verified either way.
  const head = readReport(headPath);
  if (!head)
    abstain(`head report ${headPath} is missing or not check-docs JSON`);
  if (head.scannedNothing || total(head) === 0) {
    abstain('head report measured zero source files');
  }

  requireMatchingInstrument(
    baseline.baselineCli,
    arg('--cli-version'),
    baselinePath,
  );

  const basePath = arg('--base-report');
  let ok = true;
  if (basePath) ok = requireNoLostLinks(head, basePath) && ok;
  else console.log(`docs-ratchet: ${summary(head)} at head; no merge base.`);
  ok = requireFloor(head, baseline, baselinePath) && ok;
  process.exit(ok ? 0 : 1);
}

main();
