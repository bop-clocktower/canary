#!/usr/bin/env node
/**
 * Rehearsal gate (#834, ADR 0018): run every detector and ratchet against a
 * planted defect and fail unless each one FIRES.
 *
 * A detector that stops firing does not fail -- it goes quiet, and quiet is
 * reported as a pass. This converts "probe with a planted positive before
 * trusting a fallen count" from a habit into a gate.
 *
 * Fixtures live under `rehearsal/<id>/`, each with a `rehearsal.json` manifest
 * naming its `target` and the ground truth in `expect`. The denominator is the
 * fixed REQUIRED_TARGETS list, never the number of fixtures found, so deleting
 * a fixture cannot shrink it.
 *
 * Usage:
 *   node scripts/rehearse.mjs [--root <dir>]
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = every required target fired on its planted defect
 *   1 = a target was silent, examined zero items, errored, or has no fixture
 *   3 = ABSTENTION -- no fixtures at all, so nothing was rehearsed
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compare } from './test-duration-ratchet.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = join(REPO_ROOT, 'rehearsal');

/** ADR 0018 table plus #834 F6: four detectors and three ratchets. */
export const REQUIRED_TARGETS = Object.freeze([
  'canary-savant',
  'canary-blackhawk',
  'canary-katana',
  'canary-cassandra',
  'entropy-ratchet',
  'perf-ratchet',
  'duration-ratchet',
]);

/** Every `rehearsal/<id>/rehearsal.json`, with its directory attached. */
export function loadManifests(root = DEFAULT_ROOT) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => existsSync(join(dir, 'rehearsal.json')))
    .sort()
    .map((dir) => ({
      ...JSON.parse(readFileSync(join(dir, 'rehearsal.json'), 'utf8')),
      dir,
    }));
}

function runNode(args) {
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function outcome(manifest, examined, fired, detail) {
  return { target: manifest.target, id: manifest.id, examined, fired, detail };
}

function skillCli(name) {
  return join(
    REPO_ROOT,
    'agents',
    'skills',
    'claude-code',
    name,
    'scripts',
    'cli.mjs',
  );
}

/** Spawn a skill CLI in --json mode; `out` is null when it printed no JSON. */
function spawnJson(args) {
  const run = runNode(args);
  return { status: run.status, stderr: run.stderr, out: parseJson(run.stdout) };
}

function noJson(manifest, run) {
  const detail = `no JSON (exit ${run.status}) ${run.stderr.trim()}`;
  return outcome(manifest, 0, false, detail);
}

/** cassandra's denominator is tests read; savant and blackhawk count files. */
function scanDenominator(summary = {}) {
  return summary.tests_checked ?? summary.files_scanned ?? 0;
}

/** savant, blackhawk, cassandra: a path scan that must report the rule. */
function probeScanner(manifest) {
  const cli = skillCli(manifest.target);
  const run = spawnJson([cli, '--json', '--strict', manifest.dir]);
  if (run.out === null) return noJson(manifest, run);
  const findings = run.out.findings ?? [];
  const hit = findings.some((f) => f.rule_id === manifest.expect.ruleId);
  const detail = `exit ${run.status}, ${findings.length} finding(s)`;
  const examined = scanDenominator(run.out.summary);
  return outcome(manifest, examined, hit && run.status === 1, detail);
}

/** katana: a removal diff plus critical areas that must raise the alarm. */
function probeKatana(manifest) {
  const run = spawnJson([
    skillCli('canary-katana'),
    '--json',
    '--strict',
    '--no-write',
    '--repo',
    manifest.dir,
    '--diff-file',
    join(manifest.dir, 'removal.diff'),
    '--critical-areas',
    join(manifest.dir, 'critical-areas.json'),
  ]);
  if (run.out === null) return noJson(manifest, run);
  const examined = (run.out.captured ?? []).length;
  const hit = (run.out.findings ?? []).some(
    (f) => f.kind === manifest.expect.findingKind,
  );
  return outcome(
    manifest,
    examined,
    hit && run.status === 1,
    `exit ${run.status}`,
  );
}

/**
 * entropy / perf: the real ratchet script against a synthetic report and a
 * fixture baseline. The count is read back from the ratchet's OWN output, so a
 * ratchet that exits 1 for any other reason (missing report, bad baseline) has
 * examined nothing and cannot pass as a firing.
 */
function ratchetProbe(script, measuredRe) {
  return (manifest) => {
    const run = runNode([
      join(REPO_ROOT, 'scripts', script),
      '--report',
      join(manifest.dir, 'report.txt'),
      '--baseline',
      join(manifest.dir, 'baseline.json'),
    ]);
    const text = `${run.stdout}${run.stderr}`;
    const measured = Number(measuredRe.exec(text)?.[1] ?? 0);
    const fired = measured > 0 && run.status === manifest.expect.exitCode;
    return outcome(
      manifest,
      measured,
      fired,
      `exit ${run.status}: ${text.split('\n')[0]}`,
    );
  };
}

/** duration: `compare()` over a fixture baseline must name the slow test. */
function probeDuration(manifest) {
  const data = JSON.parse(
    readFileSync(join(manifest.dir, 'durations.json'), 'utf8'),
  );
  const result = compare(
    data.baseline,
    new Map(Object.entries(data.observedMs)),
  );
  const hit = result.regressions.some(
    (r) => r.key === manifest.expect.regressedTest,
  );
  const detail = `${result.regressions.length} regression(s) over ${result.checked} tracked`;
  return outcome(manifest, result.checked, hit, detail);
}

const PROBES = {
  'canary-savant': probeScanner,
  'canary-blackhawk': probeScanner,
  'canary-cassandra': probeScanner,
  'canary-katana': probeKatana,
  'entropy-ratchet': ratchetProbe(
    'entropy-ratchet.mjs',
    /(\d+) entropy findings/,
  ),
  'perf-ratchet': ratchetProbe(
    'perf-ratchet.mjs',
    /(\d+) performance violations/,
  ),
  'duration-ratchet': probeDuration,
};

/** Run one manifest's probe. An unknown target or a thrown error is silent. */
export function runProbe(manifest) {
  const probe = PROBES[manifest.target];
  if (probe === undefined) {
    return outcome(
      manifest,
      0,
      false,
      `no probe for target "${manifest.target}"`,
    );
  }
  try {
    return probe(manifest);
  } catch (error) {
    return outcome(manifest, 0, false, `probe errored: ${error.message}`);
  }
}

function verdictLine(target, matches) {
  if (matches.length === 0) return `FAIL ${target}: no fixture`;
  if (matches.length > 1)
    return `FAIL ${target}: ${matches.length} fixtures, expected exactly one`;
  const [r] = matches;
  if (r.examined === 0)
    return `FAIL ${target}: examined zero items (abstention) -- ${r.detail}`;
  if (!r.fired)
    return `FAIL ${target}: SILENT on its planted defect -- ${r.detail}`;
  return `ok   ${target}: fired (${r.id}; ${r.detail})`;
}

/** Judge probe results against the required list. Pure. */
export function tally(results, required = REQUIRED_TARGETS) {
  const expected = required.length;
  if (results.length === 0) {
    return {
      exitCode: 3,
      summary: `0 fired of ${expected} expected`,
      lines: [
        'no rehearsal fixtures found -- nothing was rehearsed, which is not a pass',
      ],
    };
  }
  const lines = [];
  let fired = 0;
  for (const target of required) {
    const matches = results.filter((r) => r.target === target);
    const line = verdictLine(target, matches);
    lines.push(line);
    if (line.startsWith('ok')) fired += 1;
  }
  const strays = results.filter((r) => !required.includes(r.target));
  for (const r of strays)
    lines.push(`FAIL ${r.target}: not a required target (${r.id})`);
  const exitCode = fired === expected && strays.length === 0 ? 0 : 1;
  return { exitCode, summary: `${fired} fired of ${expected} expected`, lines };
}

function parseRoot(argv) {
  const i = argv.indexOf('--root');
  return i === -1 ? DEFAULT_ROOT : argv[i + 1];
}

function main(argv) {
  const results = loadManifests(parseRoot(argv)).map(runProbe);
  const { exitCode, summary, lines } = tally(results);
  for (const line of lines) console.log(line);
  console.log(`rehearse: ${summary}`);
  process.exit(exitCode);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
