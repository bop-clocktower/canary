#!/usr/bin/env node
// canary-blackhawk -- temporal-dependency linter for test files.
//
// Statically flags tests that depend on wall-clock time, a real delay, or the
// local timezone: the ones that pass all day and fail at midnight, across a DST
// boundary, or on Feb 29.
//
//   <paths>    files or directories to scan (default: the current directory).
//   --json     emit machine-readable findings instead of human text.
//   --strict   exit 1 when there are findings (default is advisory: exit 0).
//
// Tier-0 deterministic analysis -- no LLM, no network, no secrets, no
// dependency on any other skill.
//
// Invoked via `canary skills run canary-blackhawk -- [paths] [--json] [--strict]`.

import fs from 'node:fs';
import { scanPaths, toJson } from './scanner.mjs';

export const SCHEMA_VERSION = 1;

function summary(result) {
  const bySeverity = {};
  for (const f of result.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  return {
    files_scanned: result.filesScanned,
    findings: result.findings.length,
    by_severity: bySeverity,
    suppressed: result.suppressed ?? 0,
  };
}

// A trailing "N suppressed" note keeps inline-ignored lines visible but out of
// the actionable total - the pattern the PR-guardian sticky comment uses.
function suppressedNote(result) {
  const n = result.suppressed ?? 0;
  return n ? `\n${n} suppressed (inline blackhawk-ignore).` : '';
}

function renderText(result) {
  const count = result.findings.length;
  const files = result.filesScanned;
  const fp = files === 1 ? '' : 's';
  if (!count) {
    return (
      `No temporal-dependency findings (${files} file${fp} scanned).` +
      suppressedNote(result)
    );
  }
  const sp = count === 1 ? '' : 's';
  const lines = [
    `${count} temporal-dependency finding${sp} in ${files} file${fp}:`,
    '',
  ];
  for (const f of result.findings) {
    lines.push(`  ${f.file}:${f.line}  [${f.severity}] ${f.ruleId}`);
    lines.push(`      ${f.snippet}`);
    lines.push(`      why: ${f.why}`);
  }
  lines.push('');
  lines.push(
    'Advisory by default. Re-run with --strict to fail the step on findings.',
  );
  return lines.join('\n') + suppressedNote(result);
}

function parseArgs(argv) {
  const paths = [];
  const opts = { json: false, strict: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--strict') opts.strict = true;
    else paths.push(arg);
  }
  return { paths: paths.length ? paths : ['.'], opts };
}

export function main(argv = []) {
  const { paths, opts } = parseArgs(argv);

  for (const entry of paths) {
    if (!fs.existsSync(entry)) {
      console.error(`canary-blackhawk: path not found: ${entry}`);
      return 1;
    }
  }

  const result = scanPaths(paths);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          schema_version: SCHEMA_VERSION,
          findings: result.findings.map(toJson),
          summary: summary(result),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderText(result));
  }

  return opts.strict && result.findings.length ? 1 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
