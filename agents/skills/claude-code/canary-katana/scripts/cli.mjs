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
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--no-write') opts.noWrite = true;
    else if (a === '--repo') opts.repo = argv[(i += 1)];
    else if (a === '--diff-file') opts.diffFile = argv[(i += 1)];
    else if (a === '--ledger') opts.ledger = argv[(i += 1)];
    else if (a === '--critical-areas') opts.criticalAreas = argv[(i += 1)];
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
  const repo = args.repo;
  const ledgerPath = args.ledger
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
