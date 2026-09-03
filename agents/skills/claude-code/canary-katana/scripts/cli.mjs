#!/usr/bin/env node
// canary-katana -- quarantine deleted and newly-skipped tests, with provenance.
//
// Captures every removed or skipped test into an append-only ledger (who
// deleted it, when, in which commit, and why), and alarms in exactly one case:
// the removed test was the last coverage of a symbol `critical-areas.json`
// marks high-risk.
//
// Advisory by default (always exit 0). `--strict` exits 1 only on a real alarm;
// a degraded run (no critical-area data) stays exit 0 even under `--strict` --
// a gate that fails on missing data gets muted, and a muted gate is worse than
// none.
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
import * as ledger from './ledger.mjs';

// --- no-silent-abstention (#508 D2, skill-CLI convention half) ---------------
//
// Skill CLIs are deliberately self-contained -- no engine import -- so they
// cannot call `gateOutcome`. They honour the doctrine by CONVENTION, emitting
// the same greppable line the engine helper does; the skill-layer conformance
// registry (agents/skills/test/gate-conformance.test.ts) holds them to it.
//
// U+26A0 / U+2014 as escapes so this source stays ASCII, matching
// ts/src/core/gate-result.ts.
const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

const PREFIX = 'canary-katana:';

const USAGE =
  'usage: canary-katana [-h] [--repo PATH] [--diff-file PATH] [--ledger PATH]\n' +
  '                     [--critical-areas PATH] [--json] [--strict] [--no-write]\n' +
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
  '  --json                 emit machine-readable output instead of human text\n' +
  '  --strict               exit 1 on a real alarm (degraded runs stay 0)\n' +
  '  --no-write             do not append to the ledger (read-only run)';

/**
 * katana takes no positionals, so any leftover token -- dashed or not -- is a
 * usage error rather than something silently ignored, and `--` has nothing to
 * protect. The four shared invariants (null-prototype lookup, empty-value
 * rejection, arity, `--flag=value`) live in the shared parser; see #479 for why
 * they stopped living here.
 */
export const CLI_SPEC = {
  prog: 'canary-katana',
  booleans: {
    '--json': 'json',
    '--strict': 'strict',
    '--no-write': 'noWrite',
  },
  values: {
    '--repo': { key: 'repo' },
    '--diff-file': { key: 'diffFile' },
    '--ledger': { key: 'ledger' },
    '--critical-areas': { key: 'criticalAreas' },
  },
  defaults: { repo: '.' },
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
      ticket: commit ? commit.ticket : '',
    });
  });
}

function renderText(deletions, findings, degraded, scanned) {
  // #508: katana's denominator is the DIFF it read, not the deletions it found.
  // Zero deletions in a 500-line diff is a real result; zero deletions in an
  // EMPTY diff means nothing was examined at all. `0 deletion(s) captured` reads
  // identically in both cases, which is precisely the shape the doctrine bans.
  if (!scanned) {
    return (
      `${ABSTAINED_LINE} The diff was empty, so no deleted test could be ` +
      'captured. Check --repo/--diff-file, or that the range actually ' +
      'contains changes.'
    );
  }
  const lines = [`${deletions.length} deletion(s) captured.`];
  if (degraded) lines.push(alarm.DEGRADED_NOTICE);
  for (const f of findings) {
    lines.push(
      `  [${f.severity.value}] ${f.file}::${f.test} removed the last coverage of ${f.area}`,
    );
  }
  return lines.join('\n');
}

export function main(argv = []) {
  const { opts: args, help, error } = parseArgs(argv);

  // FIRST, before loadDiff and before any ledger write: a usage request or a
  // typo must never mutate the working tree.
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }

  const repo = args.repo;
  // `!= null`, not a truthiness test: "--ledger was not given" and "--ledger
  // was given an empty path" are different situations, and only the first one
  // may fall back to the default. (An empty value is rejected at parse time,
  // so this branch is now unreachable with '' -- the explicit null check keeps
  // it that way if the parser ever loosens.)
  const ledgerPath =
    args.ledger != null
      ? args.ledger
      : path.join(repo, '.canary', 'quarantine.json');

  let diff;
  let base;
  try {
    ({ text: diff, base } = loadDiff(repo, args.diffFile));
  } catch (exc) {
    if (exc.notFound) {
      console.error(`${PREFIX} ${exc.message}`);
      return 1;
    }
    console.error(`${PREFIX} could not read diff: ${exc.message}`);
    return 1;
  }

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
  const degraded = !areas.available;
  const findings = alarm.buildFindings(deletions, areas, repo);

  if (args.json) {
    const payload = {
      schema_version: ledger.SCHEMA_VERSION,
      captured: deletions.map(diffscan.deletionToDict),
      findings: findings.map(alarm.findingToDict),
      ledger: String(ledgerPath),
    };
    if (degraded) payload.degraded_notice = alarm.DEGRADED_NOTICE;
    // Additive (#508): a consumer can distinguish "no deletions" from "nothing
    // examined" without parsing prose.
    payload.checked = scanned ? 1 : 0;
    payload.abstained = !scanned;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderText(deletions, findings, degraded, scanned));
  }

  // Advisory by default (D3); --strict inherits EXIT_ABSTAINED (3) on an empty
  // diff, distinct from 1 ("captured a real deletion").
  if (args.strict && !scanned) return 3;
  return args.strict && findings.length ? 1 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
