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

import * as diffscan from './diffscan.mjs';
import * as alarm from './alarm.mjs';
import * as ledger from './ledger.mjs';

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

/** A required-value option flag error surfaces like argparse. */
function parseArgs(argv) {
  const opts = {
    repo: '.',
    diffFile: null,
    ledger: null,
    criticalAreas: null,
    json: false,
    strict: false,
    noWrite: false,
    help: false,
    error: null,
  };
  // Null-prototype: on a plain object literal every inherited key resolves
  // truthy, so `VALUE_FLAGS['toString']` would be Object.prototype.toString
  // and the token `toString` would be swallowed as a value flag instead of
  // rejected -- which, inside a real repo, runs a scan and appends to the
  // ledger.
  const VALUE_FLAGS = Object.assign(Object.create(null), {
    '--repo': 'repo',
    '--diff-file': 'diffFile',
    '--ledger': 'ledger',
    '--critical-areas': 'criticalAreas',
  });
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    // `--flag=value`, matching canary-instrument and canary-fail-fast so all
    // four ported CLIs accept the same two spellings.
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const inlineKey = eq !== -1 ? VALUE_FLAGS[a.slice(0, eq)] : undefined;

    if (a === '-h' || a === '--help') {
      opts.help = true;
      return opts;
    } else if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--no-write') opts.noWrite = true;
    else if (inlineKey !== undefined) {
      const value = a.slice(eq + 1);
      // An empty value is the missing-value case wearing a disguise:
      // `--repo=` would silently retarget the ledger from <repo>/.canary to
      // the process CWD.
      if (!value) {
        opts.error = `argument ${a.slice(0, eq)}: expected one argument`;
        return opts;
      }
      opts[inlineKey] = value;
    } else if (VALUE_FLAGS[a] !== undefined) {
      // A value is required; argparse errors when it is missing (the flag was
      // last) or looks like another option. Consuming a flag as a value would
      // silently point --repo/--ledger somewhere nonsensical.
      //
      // Empty is rejected here too, and this is the spelling that actually
      // bites: `--repo=` is typed by nobody, but `--repo "$UNSET_VAR"` expands
      // to `--repo ''` in any shell, and that used to be accepted as repo=''
      // -- writing the ledger to path.join('', '.canary', ...), i.e. the
      // process CWD instead of the target repo.
      const next = argv[i + 1];
      if (next === undefined || next === '' || next.startsWith('-')) {
        opts.error = `argument ${a}: expected one argument`;
        return opts;
      }
      opts[VALUE_FLAGS[a]] = next;
      i += 1;
    }
    // katana takes no positionals, so any leftover token -- dashed or not --
    // is a usage error rather than something silently ignored.
    else {
      opts.error = `unrecognized arguments: ${a}`;
      return opts;
    }
  }
  return opts;
}

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
    });
  });
}

function renderText(deletions, findings, degraded) {
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
  const args = parseArgs(argv);

  // FIRST, before loadDiff and before any ledger write: a usage request or a
  // typo must never mutate the working tree.
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${PREFIX} ${args.error}`);
    return 2;
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
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderText(deletions, findings, degraded));
  }

  return args.strict && findings.length ? 1 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
