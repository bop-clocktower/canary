#!/usr/bin/env node
// Denominator invariant for `harness roadmap sync` (#595).
//
// The bug: sync filters the tracker by label, so it examined 2 of 30 open
// issues. It printed that number honestly — "Examined 48 roadmap row(s) against
// 2 tracker ticket(s)" — and passed. A true number nobody read is the same
// shape as a false green, and it left sync one `--apply` away from filing 30
// duplicate issues for work that had already shipped.
//
// The invariant enforced here is exact, not a ratio: every roadmap row carrying
// an `External-ID` must point at an issue carrying the tracker label, because
// that label is precisely what decides whether sync can see the issue.
//
// A coverage ratio was the obvious alternative and is the wrong shape — most
// open issues are ordinary bug reports, not roadmap rows, so a floor would
// either sit low enough to miss the 2-of-30 case or fire on every new bug. The
// ratio is still printed, as context rather than as a gate.
//
// Exit codes follow the repo's gate convention (#508):
//   0 = verified — every linked row is visible to sync
//   2 = error
//   3 = ABSTENTION — blind rows found, or the tracker could not be read
//
//   node scripts/roadmap-denominator-check.mjs [--roadmap <path>]
//
// GH_BIN overrides the `gh` executable so the contract tests can drive a stub
// offline, mirroring HARNESS_BIN in roadmap-sync.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(REPO_ROOT, 'harness.config.json');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const roadmapPath = argValue(
  '--roadmap',
  join(REPO_ROOT, 'docs', 'roadmap.md'),
);

/** The labels sync filters the tracker by — the cause of the narrow view. */
function trackerLabels() {
  const config = JSON.parse(readFileSync(CONFIG, 'utf-8'));
  return config.roadmap?.tracker?.labels ?? [];
}

/**
 * Issue numbers the roadmap claims a link to.
 *
 * Deliberately the roadmap rather than the tracker: the question is whether the
 * rows sync will act on are visible to it, so the rows are the denominator.
 */
function linkedIssues(text) {
  const matches = text.matchAll(/\*\*External-ID:\*\*\s*github:\S+?#(\d+)/g);
  return [...new Set([...matches].map((m) => Number(m[1])))];
}

/** Every issue in the repo, with its labels. Throws if `gh` cannot answer. */
function fetchIssues() {
  const gh = process.env.GH_BIN ?? 'gh';
  const result = spawnSync(
    gh,
    [
      'issue',
      'list',
      '--state',
      'all',
      '--limit',
      '1000',
      '--json',
      'number,state,labels',
    ],
    { encoding: 'utf-8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh exited ${result.status}: ${result.stderr?.trim()}`);
  }
  return JSON.parse(result.stdout);
}

function abstain(message) {
  console.error(`x ${message}`);
  process.exit(3);
}

const linked = linkedIssues(readFileSync(roadmapPath, 'utf-8'));
const labels = trackerLabels();

if (linked.length === 0) {
  // Zero rows to check is an abstention, never a pass — the same reasoning
  // roadmap-groom.mjs exits 3 on a zero-row parse.
  abstain(
    `ZERO DENOMINATOR: no linked rows in ${roadmapPath}.\n` +
      '  Nothing to verify is not the same as everything checking out.',
  );
}

let issues;
try {
  issues = fetchIssues();
} catch (failure) {
  // "Cannot verify" is a finding, not a skip. Exiting 0 here would rebuild the
  // exact silence this check exists to break.
  abstain(
    `CANNOT VERIFY tracker visibility: ${failure.message}\n` +
      '  Needs an authenticated `gh`. Not skipped — sync needs the network\n' +
      '  anyway, so an unreachable tracker is a real blocker, not an excuse.',
  );
}

const labelled = new Set(
  issues
    .filter((issue) => {
      const names = issue.labels.map((label) => label.name);
      return labels.every((wanted) => names.includes(wanted));
    })
    .map((issue) => issue.number),
);

const openCount = issues.filter((issue) => issue.state === 'OPEN').length;
const openLabelled = issues.filter(
  (issue) => issue.state === 'OPEN' && labelled.has(issue.number),
).length;

const blind = linked.filter((number) => !labelled.has(number));

console.log(
  `i ${linked.length} linked roadmap row(s); ` +
    `${openLabelled}/${openCount} open issue(s) carry ${labels.join(' + ')}`,
);

if (blind.length > 0) {
  // Named, not counted. A count sends the reader back to the tracker by hand,
  // which is how the original 2-of-30 line got skimmed.
  abstain(
    `${blind.length} linked roadmap row(s) are INVISIBLE to roadmap sync.\n` +
      `  Missing the ${labels.join(' + ')} label: ` +
      blind.map((number) => `#${number}`).join(', ') +
      '\n' +
      '  Sync filters the tracker by that label, so it will treat these rows\n' +
      '  as needing a ticket they already have. See bop-clocktower/canary#595.',
  );
}

console.log('+ every linked row is visible to roadmap sync');
