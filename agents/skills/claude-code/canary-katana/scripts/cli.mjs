#!/usr/bin/env node
// canary-katana -- quarantine deleted and newly-skipped tests, with provenance.
//
// Captures every removed or skipped test into an append-only ledger (who
// deleted it, when, in which commit, and why), and alarms in exactly one case:
// the removed test was the last coverage of a symbol `critical-areas.json`
// marks high-risk.
//
// Advisory by default (always exit 0). `--strict` exits 1 only on a real alarm,
// and 3 (abstained, ADR 0009) on an empty diff, when the diff touched a
// critical area katana cannot assess (#1242, #1253), or when the map is older
// than --max-age-days or its age cannot be verified (#1325). A degraded run (no
// critical-area data) stays exit 0 even under `--strict` -- a gate that fails
// on missing data gets muted, and a muted gate is worse than none.
//
// Invoked via `canary skills run canary-katana -- [options]`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import * as diffscan from './diffscan.mjs';
import * as alarm from './alarm.mjs';
import { assess, notAssessedToDict } from './alarm.mjs';
import { DEFAULT_MAX_AGE_DAYS, mapFreshness } from './areas.mjs';
import * as ledger from './ledger.mjs';
import { checkUsageError, runCheck } from './check.mjs';
import { abstains, renderText } from './verdict-text.mjs';
import { isMain } from '../../../lib/is-main.mjs';

const PREFIX = 'canary-katana:';

const USAGE =
  'usage: canary-katana [-h] [--repo PATH] [--diff-file PATH] [--ledger PATH]\n' +
  '                     [--critical-areas PATH] [--max-age-days N] [--json]\n' +
  '                     [--strict] [--no-write]\n' +
  '       canary-katana --check [--record] [--repo PATH] [--ledger PATH] [--json]\n' +
  '                     [PATH ...]\n' +
  '\n' +
  'Quarantine deleted and newly-skipped tests into an append-only ledger with\n' +
  'provenance, and alarm when a removal drops the last coverage of a critical\n' +
  'area.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help             show this help message and exit\n' +
  '  --repo PATH            repository to inspect (default: .)\n' +
  '  --diff-file PATH       read the diff from a file instead of git\n' +
  '  --ledger PATH          ledger location (default: <repo>/.canary/quarantine.json)\n' +
  '  --critical-areas PATH  critical-areas.json used to raise alarms\n' +
  '  --max-age-days N       warn when that map is older than N days (default:\n' +
  `                         ${DEFAULT_MAX_AGE_DAYS}); its \`generated\` stamp is the age\n` +
  '  --json                 emit machine-readable output instead of human text\n' +
  '  --strict               exit 1 on a real alarm, 3 when abstained (empty diff,\n' +
  '                         a touched area katana cannot assess, or a stale or\n' +
  '                         undated map); degraded runs stay 0\n' +
  '  --no-write             do not append to the ledger (read-only run)\n' +
  '  --check                fail (exit 1) when a static skip in the test files\n' +
  '                         has no ledger row; 3 when nothing could be checked.\n' +
  '                         PATHs narrow the scan to those files or directories\n' +
  '  --record               with --check: append a row for each unledgered skip';

/**
 * Only `--check` takes positionals (#1319); anywhere else a leftover token is
 * a usage error (checkUsageError) rather than something silently ignored. The
 * four shared invariants (null-prototype lookup, empty-value rejection, arity,
 * `--flag=value`) live in the shared parser; see #479 for why they stopped
 * living here.
 */
export const CLI_SPEC = {
  prog: 'canary-katana',
  booleans: {
    '--json': 'json',
    '--strict': 'strict',
    '--no-write': 'noWrite',
    '--check': 'check',
    '--record': 'record',
  },
  values: {
    '--repo': { key: 'repo' },
    '--diff-file': { key: 'diffFile' },
    '--ledger': { key: 'ledger' },
    '--critical-areas': { key: 'criticalAreas' },
    '--max-age-days': { key: 'maxAgeDays', type: 'int' },
  },
  defaults: { repo: '.', maxAgeDays: DEFAULT_MAX_AGE_DAYS },
  // Only --check takes PATHs; checkUsageError rejects them anywhere else.
  positionals: { key: 'paths' },
};

const parseArgs = createParser(CLI_SPEC);

/**
 * Return { text, base }. `base` is a git ref when one is resolvable. With
 * diffFile the diff is read verbatim and git is still consulted (best-effort)
 * for provenance; without it the diff is computed from the repo's own history.
 */
function loadDiff(repo, diffFile) {
  if (diffFile) {
    if (!fs.existsSync(diffFile)) {
      const err = new Error(`diff file not found: ${diffFile}`);
      err.notFound = true;
      throw err;
    }
    const text = fs.readFileSync(diffFile, 'utf8');
    let base = null;
    try {
      base = diffscan.resolveBase(repo, null);
    } catch {
      base = null; // non-git repo: provenance stays unknown
    }
    return { text, base };
  }
  const base = diffscan.resolveBase(repo, null);
  return { text: diffscan.diffText(repo, base), base };
}

function provenance(repo, base, file) {
  if (base === null) return null;
  try {
    return diffscan.commitForFile(repo, base, file);
  } catch {
    return null; // missing history is unknown, not fatal
  }
}

function toEntries(repo, base, deletions) {
  return deletions.map((d) => {
    const commit = provenance(repo, base, d.file);
    return ledger.LedgerEntry({
      test: d.name,
      file: d.file,
      kind: d.kind,
      marker: d.marker,
      commit: commit ? commit.sha : '',
      author: commit ? commit.author : 'unknown',
      date: commit ? commit.date : '',
      reason: commit ? commit.subject : '',
      // The `Ticket:` trailer is one way an issue link arrives; a quarantine
      // producer writing a caused row is the other. Both land in `issue`.
      issue: commit ? commit.ticket : '',
    });
  });
}

/** The --json document. Every field after `ledger` is additive. */
function jsonPayload(run, ledgerPath) {
  const { deletions, verdict } = run;
  return {
    schema_version: ledger.SCHEMA_VERSION,
    captured: deletions.map(diffscan.deletionToDict),
    findings: verdict.findings.map(alarm.findingToDict),
    ledger: String(ledgerPath),
    ...(run.degraded ? { degraded_notice: alarm.DEGRADED_NOTICE } : {}),
    // #508: "no deletions" vs "nothing examined", without parsing prose.
    checked: run.scanned ? 1 : 0,
    abstained: abstains(run),
    // #1242: the area denominator; `at_stake` marks areas this diff touched.
    areas: {
      total: verdict.total,
      assessed: verdict.total - verdict.notAssessed.length,
      not_assessed: verdict.notAssessed.map(notAssessedToDict),
    },
    // #1325: how old the map scored against is; absent when there is no map.
    ...(run.freshness ? { map: freshnessToDict(run.freshness) } : {}),
  };
}

const freshnessToDict = (f) => ({
  generated: f.generated,
  age_days: f.ageDays,
  max_age_days: f.maxAgeDays,
  freshness: f.status,
});

/** A zero or negative limit would call every map stale: a typo, not intent. */
const maxAgeError = (n) =>
  n >= 1 ? null : `argument --max-age-days: must be at least 1, got ${n}`;

/**
 * @param {string[]} argv
 * @param {{now?: () => Date}} [deps] tests inject the clock the map's age is
 *   measured against
 */
export function main(argv = [], deps = {}) {
  const now = deps.now ?? (() => new Date());
  const { opts: args, positionals, help, error } = parseArgs(argv);

  // FIRST, before loadDiff and before any ledger write: a usage request or a
  // typo must never mutate the working tree.
  if (help) {
    console.log(USAGE);
    return 0;
  }
  const usage =
    error ?? checkUsageError(args, positionals) ?? maxAgeError(args.maxAgeDays);
  if (usage) {
    console.error(formatUsageError(CLI_SPEC.prog, usage));
    return EXIT_USAGE;
  }

  const repo = args.repo;
  const ledgerPath = ledgerPathFor(args);
  if (args.check) return runCheck(args, positionals, ledgerPath);

  const loaded = readDiff(repo, args.diffFile);
  if (!loaded) return 1;
  const { text: diff, base } = loaded;

  // Non-blank diff text is the denominator probe: `loadDiff` succeeding does
  // not mean it returned anything to scan.
  const scanned = diff.trim().length > 0;
  const deletions = diffscan.findDeletions(diff);
  const entries = toEntries(repo, base, deletions);

  if (!args.noWrite) {
    try {
      ledger.appendEntries(ledgerPath, entries);
    } catch (exc) {
      console.error(`${PREFIX} ${exc.message}`);
      return 1;
    }
  }

  const areas = alarm.loadCriticalAreas(args.criticalAreas);
  const verdict = assess(deletions, areas, repo, diff);
  const freshness = areas.available
    ? mapFreshness(areas.generated, now(), args.maxAgeDays)
    : null;
  const run = {
    scanned,
    degraded: !areas.available,
    deletions,
    verdict,
    freshness,
  };

  if (args.json) {
    console.log(JSON.stringify(jsonPayload(run, ledgerPath), null, 2));
  } else {
    console.log(renderText(run));
  }

  return exitCodeFor(run, args.strict);
}

/**
 * `!= null`, not a truthiness test: "--ledger was not given" and "--ledger
 * was given an empty path" are different situations, and only the first one
 * may fall back to the default. (An empty value is rejected at parse time,
 * so this branch is now unreachable with '' -- the explicit null check keeps
 * it that way if the parser ever loosens.)
 */
function ledgerPathFor(args) {
  return args.ledger != null
    ? args.ledger
    : path.join(args.repo, '.canary', 'quarantine.json');
}

/** The diff to scan, or null after printing why it could not be read. */
function readDiff(repo, diffFile) {
  try {
    return loadDiff(repo, diffFile);
  } catch (exc) {
    console.error(
      exc.notFound
        ? `${PREFIX} ${exc.message}`
        : `${PREFIX} could not read diff: ${exc.message}`,
    );
    return null;
  }
}

/**
 * Advisory by default (D3). --strict: 1 on a real alarm, else 3 when the run
 * abstained (#508, #1242): a 0 would claim coverage nobody could check.
 */
function exitCodeFor(run, strict) {
  if (!strict) return 0;
  if (run.verdict.findings.length) return 1;
  return abstains(run) ? 3 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
//
// `process.exitCode`, not `process.exit()`: a large `--json` payload exceeds
// the pipe buffer, and `process.exit` tears the process down mid-write, leaving
// truncated JSON that still exits 0 (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
