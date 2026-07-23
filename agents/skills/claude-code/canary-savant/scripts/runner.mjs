// Tier-2 dynamic confirmer for canary-savant (Phase 2): baseline -> shuffle ->
// classify, pytest-first, with honest degradation when a shuffle plugin is
// absent.
//
// Determinism here means the *tool* is reproducible per seed, not that outcomes
// are (finding non-determinism is the point). Every run prints the seed and an
// exact reproduce command. Tier-0 in the real sense: no LLM, no network, no
// secrets -- savant only ever shells out to the project's own pytest.
//
// Isolation + polluter bisect (naming the culprit, not just the victim) are
// Phase 3 and are deliberately absent here.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const FAILED = new Set(['failed', 'error']);

/**
 * Parse a pytest JUnit XML string into { "classname::name": outcome }.
 * Outcome is one of passed | failed | error | skipped. JUnit is machine-
 * generated and shallow, so a scan over <testcase> elements is sufficient and
 * keeps the skill dependency-free.
 * @param {string} xml
 * @returns {Record<string,string>}
 */
export function parseJunitXml(xml) {
  const outcomes = {};
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = caseRe.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[3] || '';
    const cls = /\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    let outcome = 'passed';
    if (inner.includes('<failure')) outcome = 'failed';
    else if (inner.includes('<error')) outcome = 'error';
    else if (inner.includes('<skipped')) outcome = 'skipped';
    outcomes[`${cls}::${name}`] = outcome;
  }
  return outcomes;
}

/** Default probe: can the project's python import the given plugin module? */
function defaultProbe(moduleName) {
  const res = spawnSync(
    'python3',
    [
      '-c',
      `import importlib.util,sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`,
    ],
    { stdio: 'ignore' },
  );
  return res.status === 0;
}

/**
 * Return the shuffle plugin to drive, preferring pytest-randomly, or null.
 * @param {(name: string) => boolean} [probe]
 * @returns {string|null}
 */
export function detectShufflePlugin(probe = defaultProbe) {
  if (probe('randomly')) return 'pytest-randomly';
  if (probe('random_order')) return 'pytest-random-order';
  return null;
}

const pytestBase = (paths, junitPath) => [
  'python3',
  '-m',
  'pytest',
  ...paths,
  '--tb=no',
  '-q',
  `--junitxml=${junitPath}`,
];

/** In-order baseline command; forces randomly off when that plugin is active. */
export function buildBaselineCmd(paths, junitPath, plugin) {
  const cmd = pytestBase(paths, junitPath);
  if (plugin === 'pytest-randomly') cmd.push('-p', 'no:randomly');
  return cmd;
}

/** Shuffle command with a pinned seed, using the framework's own plugin. */
export function buildShuffleCmd(paths, junitPath, seed, plugin) {
  const cmd = pytestBase(paths, junitPath);
  if (plugin === 'pytest-random-order') {
    cmd.push('--random-order', `--random-order-seed=${seed}`);
  } else {
    cmd.push('-p', 'randomly', `--randomly-seed=${seed}`);
  }
  return cmd;
}

/**
 * Classify tests green-in-baseline by their two same-seed shuffled reruns.
 * Fail in both -> order-dependent (reproducible under that order). Disagree
 * -> nondeterministic (flaky, not order). Passed in both -> clean.
 * @returns {{victim: string, classification: string}[]}
 */
export function classify(baseline, shuffle1, shuffle2, seed) {
  void seed;
  const findings = [];
  for (const [test, outcome] of Object.entries(baseline)) {
    if (outcome !== 'passed') continue; // red-in-baseline is not an order bug
    const f1 = FAILED.has(shuffle1[test]);
    const f2 = FAILED.has(shuffle2[test]);
    if (f1 && f2)
      findings.push({ victim: test, classification: 'order-dependent' });
    else if (f1 !== f2)
      findings.push({ victim: test, classification: 'nondeterministic' });
  }
  return findings;
}

/** Run one pytest invocation and parse its JUnit report into outcomes. */
export function runPytestSuite(cmd, junitPath) {
  spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
  let xml;
  try {
    xml = fs.readFileSync(junitPath, 'utf8');
  } catch {
    return {};
  }
  return parseJunitXml(xml);
}

/**
 * Orchestrate the dynamic confirmation.
 * @param {string[]} paths
 * @param {{seed: number, plugin?: string|null,
 *          runSuite?: (cmd: string[]) => Record<string,string>,
 *          probe?: (name: string) => boolean}} [options]
 */
export function confirm(paths, options = {}) {
  const { seed, runSuite, probe } = options;
  const plugin =
    options.plugin !== undefined ? options.plugin : detectShufflePlugin(probe);

  const base = {
    status: 'ok',
    seed,
    plugin,
    victims: [],
    nondeterministic: [],
    baselineFailures: [],
    reproduce: '',
  };

  if (!plugin) {
    return {
      ...base,
      status: 'no_plugin',
      message:
        'Tier 2 needs a pytest shuffle plugin. Install pytest-randomly (or ' +
        'pytest-random-order) to enable order-dependence confirmation.',
    };
  }

  // A temp path is only needed by the real runner; the injected stub ignores it.
  const junit = '.savant-junit.xml';
  const run = runSuite || ((cmd) => runPytestSuite(cmd, junit));

  const baseline = run(buildBaselineCmd(paths, junit, plugin));
  const baselineFailures = Object.entries(baseline)
    .filter(([, o]) => FAILED.has(o))
    .map(([t]) => t);
  if (baselineFailures.length) {
    return {
      ...base,
      status: 'baseline_red',
      baselineFailures,
      message:
        'The suite is not green in declared order; fix that first. ' +
        'Order-dependence is undefined over an already-failing suite.',
    };
  }

  const shuffleCmd = buildShuffleCmd(paths, junit, seed, plugin);
  const s1 = run(shuffleCmd);
  const s2 = run(buildShuffleCmd(paths, junit, seed, plugin));
  const findings = classify(baseline, s1, s2, seed);

  return {
    ...base,
    victims: findings.filter((f) => f.classification === 'order-dependent'),
    nondeterministic: findings.filter(
      (f) => f.classification === 'nondeterministic',
    ),
    reproduce: shuffleCmd.join(' '),
  };
}
