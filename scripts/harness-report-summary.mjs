#!/usr/bin/env node
// Human-readable summary of a `harness ci check --json` report (#588).
//
// The report is ~162 KB and TWO independent truncations kept anyone from
// reading it in CI:
//
//   1. The Actions log stops at 60 KB, mid-token, with no marker.
//   2. Node's stdout is ASYNC when it is a pipe, so `process.exit()` drops
//      whatever is still buffered — ~64 KB in practice. Redirecting to a file
//      makes the fd synchronous, which is why `harness.yml` now writes
//      `harness-report.json` instead of piping.
//
// On PR #584 the first cut landed after check four of nine. The log showed
// `pass/pass/warn/warn` and zero error-severity findings on a job that exited
// 1; the real cause, `arch: fail`, was past the cut. A failing job whose log
// reads "nothing failed" is a false green wearing a byte limit.
//
// This prints the part a human needs — every check, its status, and every
// error-severity issue — small enough that no limit can reach it. The full
// report is uploaded as an artifact for everything else.
//
// Warning-severity detail IS capped, because 139 "undocumented file" lines
// help nobody. The cap always states its remainder: a silent cap is the bug
// this script closes, so reproducing it at a smaller scale would be worse
// than not summarising at all.
//
// Exit codes follow the repo's gate convention (#508):
//   0 = summarised (regardless of what the report itself said — the
//       `harness ci check` step is what gates; a second failure here would
//       only obscure which step is authoritative)
//   2 = usage error
//   3 = ABSTENTION — the report is missing, truncated, or has zero checks,
//       so this script verified nothing. That is precisely the #588 condition
//       returning, so it is reported loudly rather than passing quietly.
//
// The `arch` check gets one extra section (#626). Its entry in the report is
// `{name, status, issues: [], durationMs}` with zero error-severity issues
// whether it failed on a NEW violation or on the ratchet firing over
// pre-existing debt — two states wanting opposite responses, indistinguishable
// here. `--arch <check-arch --json>` supplies the missing split; without it, a
// failing arch check says so rather than looking like an ordinary red.
//
//   node scripts/harness-report-summary.mjs [path] [--arch arch-report.json]
//                                           (default harness-report.json)
import { appendFileSync, readFileSync } from 'node:fs';

import {
  archAnnotations,
  archVerdictLines,
  classifyArchReport,
  loadArchReport,
} from './arch-verdict.mjs';

/** Warning/info issues shown per check before the remainder is summarised. */
const WARN_DETAIL_CAP = 10;

const STATUS_ORDER = { fail: 0, warn: 1, skip: 2, pass: 3 };

function abstain(message) {
  console.log(`::error title=Harness summary unavailable::${message}`);
  console.error(`ABSTAINED: ${message}`);
  process.exit(3);
}

/** Reads and parses the report, abstaining on every unreadable shape. */
function loadReport(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    abstain(`cannot read ${path}: ${error.message}`);
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    // The overwhelmingly likely cause is a truncated write, which is the
    // failure mode this whole script exists for — so name it, rather than
    // reporting a bare SyntaxError nobody can act on.
    abstain(
      `${path} is not parseable JSON (${raw.length} bytes) — likely truncated: ${error.message}`,
    );
  }
  if (!Array.isArray(report?.checks)) {
    abstain(`${path} carries no checks array — nothing was summarised`);
  }
  if (report.checks.length === 0) {
    abstain(`${path} reports zero checks; zero checks verified is not a pass`);
  }
  return report;
}

function issuesBySeverity(check) {
  const issues = Array.isArray(check.issues) ? check.issues : [];
  return {
    errors: issues.filter((i) => i.severity === 'error'),
    rest: issues.filter((i) => i.severity !== 'error'),
    total: issues.length,
  };
}

function locate(issue) {
  if (!issue.file) return '';
  return issue.line ? ` (${issue.file}:${issue.line})` : ` (${issue.file})`;
}

/** One fixed-width line per check — the part #584's log never got to. */
function checkLine(check) {
  const status = String(check.status).padEnd(5);
  const name = String(check.name).padEnd(14);
  const count = `${issuesBySeverity(check).total} issue(s)`.padEnd(12);
  return `  ${status} ${name} ${count} ${check.durationMs ?? '?'}ms`;
}

function headline(report) {
  const s = report.summary ?? {};
  const counts = [
    `${s.passed ?? '?'} passed`,
    `${s.failed ?? '?'} failed`,
    `${s.warnings ?? '?'} warning(s)`,
    `${s.skipped ?? '?'} skipped`,
  ].join(', ');
  return `harness ci check — ${report.checks.length} check(s): ${counts} (exit ${report.exitCode ?? '?'})`;
}

/** Detail lines for one check: every error, then capped warnings. */
function detailFor(check) {
  const { errors, rest, total } = issuesBySeverity(check);
  if (total === 0) return [];
  const lines = [`${check.name} — ${total} issue(s):`];
  // Errors are never capped: an unshown error is the #588 defect exactly.
  for (const issue of errors) {
    lines.push(`  error  ${issue.message}${locate(issue)}`);
  }
  for (const issue of rest.slice(0, WARN_DETAIL_CAP)) {
    lines.push(`  ${issue.severity}  ${issue.message}${locate(issue)}`);
  }
  const hidden = rest.length - WARN_DETAIL_CAP;
  if (hidden > 0) {
    lines.push(`  … +${hidden} more — see the harness-report artifact`);
  }
  return lines;
}

function annotations(report) {
  const lines = [];
  for (const check of report.checks) {
    for (const issue of issuesBySeverity(check).errors) {
      lines.push(
        `::error title=harness ${check.name}::${issue.message}${locate(issue)}`,
      );
    }
  }
  return lines;
}

/**
 * The arch section (#626): which of the two indistinguishable failures is it?
 *
 * A missing or unreadable detail report is reported, never skipped — "the arch
 * check is red and I cannot tell you why" is the finding, and a silent omission
 * would leave the reader exactly where #626 found them.
 */
function archSection(report, archPath) {
  const check = report.checks.find((c) => c.name === 'arch');
  if (!check) return { lines: [], annotations: [] };
  const failing = check.status === 'fail' || check.status === 'warn';

  if (archPath === undefined) {
    if (!failing) return { lines: [], annotations: [] };
    const message =
      'arch — CANNOT DISAMBIGUATE: no `harness check-arch --json` report was supplied, ' +
      'so a new violation and a stale baseline are indistinguishable here. Re-run with ' +
      '`--arch <report>`, or run `harness check-arch --json` locally and read `newViolations`.';
    return {
      lines: [message],
      annotations: [`::error title=harness arch::${message}`],
    };
  }

  const loaded = loadArchReport(archPath);
  const verdict = loaded.ok
    ? classifyArchReport(loaded.report)
    : { verdict: 'unknown', reason: loaded.reason };
  if (verdict.verdict === 'unknown') {
    const message = `arch — CANNOT DISAMBIGUATE: ${verdict.reason}. Run \`harness check-arch --json\` and read \`newViolations\`.`;
    return {
      lines: [message],
      annotations: [`::error title=harness arch::${message}`],
    };
  }
  return {
    lines: archVerdictLines(verdict),
    annotations: archAnnotations(verdict),
  };
}

function render(report) {
  const ordered = [...report.checks].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
  );
  const lines = [headline(report), '', ...ordered.map(checkLine)];
  for (const check of ordered) {
    const detail = detailFor(check);
    if (detail.length > 0) lines.push('', ...detail);
  }
  return lines;
}

/**
 * Mirrors the summary into the job summary panel. Best-effort on purpose: a
 * missing or unwritable `GITHUB_STEP_SUMMARY` must not cost the stdout
 * summary, which is the copy that actually closes #588.
 */
function writeStepSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const body = ['## Harness checks', '', '```text', ...lines, '```', ''];
  try {
    appendFileSync(path, `${body.join('\n')}\n`, 'utf-8');
  } catch (error) {
    console.log(
      `::warning title=Step summary unavailable::${error.message} (stdout summary is unaffected)`,
    );
  }
}

/** `[report.json] [--arch arch-report.json]`, in either order. */
function parseArgs(argv) {
  const positional = [];
  let arch;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--arch') {
      arch = argv[++i];
      if (arch === undefined) return { usage: '--arch needs a path' };
    } else if (argv[i].startsWith('-')) {
      return { usage: `unknown option ${argv[i]}` };
    } else {
      positional.push(argv[i]);
    }
  }
  return { path: positional[0] ?? 'harness-report.json', arch };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.usage !== undefined) {
    console.error(
      `harness-report-summary.mjs: ${args.usage}\nusage: harness-report-summary.mjs [report.json] [--arch arch-report.json]`,
    );
    process.exit(2);
  }
  const report = loadReport(args.path);
  const arch = archSection(report, args.arch);
  const lines = [...render(report)];
  if (arch.lines.length > 0) lines.push('', ...arch.lines);
  for (const line of lines) console.log(line);
  for (const line of [...annotations(report), ...arch.annotations]) {
    console.log(line);
  }
  writeStepSummary(lines);
}

main();
