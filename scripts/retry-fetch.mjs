#!/usr/bin/env node
/**
 * Run a CI network FETCH with a bounded retry (#1533).
 *
 *   node scripts/retry-fetch.mjs [--expect-semver] -- <command> [args...]
 *
 * For fetches ONLY: `npm install -g "$HARNESS_CLI"`, or the
 * `npx -p "$HARNESS_CLI" harness --version` probe that resolves the floating
 * major. Never wrap a check, test or validate: a retry there turns a real
 * failure into a pass. `ts/test/harness-cli-fetch-retry.test.ts` fails on a
 * workflow that wraps anything else.
 *
 * Why: `HARNESS_CLI` floats at a major on purpose, so CI is the first to pull
 * a just-published release, and the registry can 404 its new transitive
 * tarballs for a few seconds (PR #1649, 2026-11-23: four required checks red
 * on attempt 1, green on attempt 2 of the same SHA).
 *
 * Contract:
 * - at most MAX_ATTEMPTS runs, BACKOFF_SECONDS apart;
 * - every failed attempt emits a `::warning::` naming the attempt and the
 *   tail of the command's output, so a retried pass is never silent;
 * - after the last failed attempt, an `::error::` and a non-zero exit.
 *
 * `--expect-semver` also treats an exit 0 whose last stdout line is not a
 * version as a failure, and prints only the version on success. That is the
 * `got ''` case of the resolve steps, whose `2>/dev/null` hid the cause.
 *
 * Annotations go to stderr so stdout stays exactly the command's output for
 * `$(...)` capture; the Actions runner reads workflow commands from both.
 */

import { spawnSync } from 'node:child_process';

const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [10, 30];
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;
const TAIL_LINES = 6;

/** Workflow-command data must be one line: escape `%`, CR and LF. */
const escapeData = (s) =>
  s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const lastLines = (text, n) =>
  text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n);

/**
 * Delays between attempts in ms. `RETRY_FETCH_BACKOFF_MS` (e.g. `0,0`) exists
 * so tests do not sleep 40s; it changes the wait, never the attempt bound.
 */
function backoffMs() {
  const override = process.env.RETRY_FETCH_BACKOFF_MS;
  if (override) return override.split(',').map((v) => Number(v) || 0);
  return BACKOFF_SECONDS.map((s) => s * 1000);
}

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Parse `[--expect-semver] -- cmd args...`; undefined on a usage error. */
function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep === -1 || sep === argv.length - 1) return undefined;
  const flags = argv.slice(0, sep);
  if (flags.some((f) => f !== '--expect-semver')) return undefined;
  return {
    expectSemver: flags.includes('--expect-semver'),
    command: argv.slice(sep + 1),
  };
}

const versionOf = (stdout) => (lastLines(stdout, 1)[0] ?? '').trim();

/** Run the command once; never throws. */
function run([cmd, ...args]) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status ?? 1,
    signal: r.signal,
    error: r.error,
  };
}

/** Why the attempt failed, or undefined when it succeeded. */
function problemOf(r, expectSemver) {
  if (r.error) return r.error.message;
  if (r.signal) return `was killed by ${r.signal}`;
  if (r.status !== 0) return `exited ${r.status}`;
  if (expectSemver && !SEMVER.test(versionOf(r.stdout))) {
    return `exited 0 but printed no version (got '${versionOf(r.stdout)}')`;
  }
  return undefined;
}

function warn(n, label, result, next) {
  const detail = lastLines(`${result.stderr}\n${result.stdout}`, TAIL_LINES);
  const message = [`${label} ${result.problem}; ${next}.`, ...detail].join(
    '\n',
  );
  process.stderr.write(
    `::warning title=retry-fetch attempt ${n}/${MAX_ATTEMPTS} failed::${escapeData(message)}\n`,
  );
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      'usage: retry-fetch.mjs [--expect-semver] -- <command> [args...]\n',
    );
    return 2;
  }
  const label = parsed.command.join(' ');
  const delays = backoffMs();
  let result;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    result = run(parsed.command);
    result.problem = problemOf(result, parsed.expectSemver);
    if (!result.problem) {
      process.stderr.write(result.stderr);
      process.stdout.write(
        parsed.expectSemver ? `${versionOf(result.stdout)}\n` : result.stdout,
      );
      return 0;
    }
    // The failed attempt's full output, for the log; stdout stays clean.
    process.stderr.write(`${result.stdout}${result.stderr}`);
    const last = n === MAX_ATTEMPTS;
    // Names the declared backoff; the test-only override shortens the sleep.
    warn(
      n,
      label,
      result,
      last ? 'giving up' : `retrying in ${BACKOFF_SECONDS[n - 1]}s`,
    );
    if (!last) sleep(delays[n - 1] ?? 0);
  }
  process.stderr.write(
    `::error title=retry-fetch failed::${escapeData(`${label} failed after ${MAX_ATTEMPTS} attempts: ${result.problem}`)}\n`,
  );
  return result.status || 1;
}

process.exitCode = main();
