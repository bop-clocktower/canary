#!/usr/bin/env node
/**
 * Record a vitest run into canary's own history store, so canary's fleet-health
 * commands have real data to analyze (dogfooding, #508 follow-up).
 *
 * `canary analyze` / `canary history` read `test-results/reports/history-v2.jsonl`.
 * Nothing wrote it for canary itself, so every one of those commands has only
 * ever been exercised against synthetic fixtures — including the runs-vs-rows
 * denominator design, which is precisely the part that needs a POPULATED store
 * to be meaningful. (`canary history push` is the wrong tool: it pushes an
 * existing local file to a REMOTE store.)
 *
 * Reads vitest's `--reporter=json` output and appends one v2 record.
 *
 * Usage:
 *   node scripts/dogfood-record-run.mjs <vitest.json> --suite <name> [--repo o/r]
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const HISTORY = 'test-results/reports/history-v2.jsonl';
const SCHEMA_VERSION = 2;

function arg(flag, fallback = undefined) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** vitest json -> the flat per-test rows the v2 record carries. */
function toTests(report) {
  const rows = [];
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      // vitest: passed | failed | skipped | pending | todo. Canary's vocabulary
      // is passed/failed/flaky/skipped; vitest has no flaky status of its own,
      // so a retried-then-passed test is reported as passed and is invisible
      // here. Recorded honestly rather than guessed at.
      const status =
        t.status === 'passed'
          ? 'passed'
          : t.status === 'failed'
            ? 'failed'
            : 'skipped';
      rows.push({
        test_name: t.fullName || t.title || '(unnamed)',
        status,
        duration_ms: Math.round(t.duration ?? 0),
        ...(t.failureMessages?.length
          ? { error_text: String(t.failureMessages[0]).slice(0, 2000) }
          : {}),
      });
    }
  }
  return rows;
}

function main() {
  const source = process.argv[2];
  const suite = arg('--suite');
  if (!source || !suite) {
    process.stderr.write(
      'usage: dogfood-record-run.mjs <vitest.json> --suite <name> [--repo o/r]\n',
    );
    return 2;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(source, 'utf-8'));
  } catch (exc) {
    // Loud, not silent: a missing or unparseable report means this run recorded
    // NOTHING, and a later `analyze` would abstain without ever saying why.
    process.stderr.write(
      `dogfood-record-run: cannot read ${source} (${exc.message}) -- ` +
        'no run recorded. The analyze step will abstain.\n',
    );
    return 1;
  }

  const tests = toTests(report);
  if (tests.length === 0) {
    process.stderr.write(
      `dogfood-record-run: ${source} contained zero test results -- ` +
        'refusing to record an empty run (that is the denominator collapsing, ' +
        'not a passing suite).\n',
    );
    return 1;
  }

  const count = (s) => tests.filter((t) => t.status === s).length;
  const env = process.env;
  const stamp = new Date(report.startTime ?? Date.now()).toISOString();
  const sha = env['GITHUB_SHA'] ?? 'local';

  const record = {
    schema_version: SCHEMA_VERSION,
    run_id: `${suite}-${sha.slice(0, 12)}-${Date.parse(stamp)}`,
    suite,
    repo: arg('--repo', env['GITHUB_REPOSITORY'] ?? 'bop-clocktower/canary'),
    branch: env['GITHUB_REF_NAME'] ?? 'local',
    commit_sha: sha,
    timestamp: stamp.replace('Z', '+00:00'),
    total: tests.length,
    passed: count('passed'),
    failed: count('failed'),
    flaky: 0,
    skipped: count('skipped'),
    duration_ms: Math.round(
      tests.reduce((n, t) => n + (t.duration_ms ?? 0), 0),
    ),
    tests,
  };

  mkdirSync(dirname(HISTORY), { recursive: true });
  appendFileSync(HISTORY, `${JSON.stringify(record)}\n`, 'utf-8');
  process.stdout.write(
    `dogfood-record-run: recorded ${tests.length} result(s) for ${suite} ` +
      `(${record.passed} passed, ${record.failed} failed, ` +
      `${record.skipped} skipped) -> ${HISTORY}\n`,
  );
  return 0;
}

process.exit(main());
