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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// JUnit artifacts go to the OS temp dir, never the user's repo root.
const TMP_JUNIT = path.join(os.tmpdir(), 'savant-junit.xml');
const TMP_POLLUTER = path.join(os.tmpdir(), 'savant-polluter.xml');

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
 * Detect the test framework for a target: pytest or vitest. File extensions win;
 * a bare directory falls back to config-file markers (injectable `exists`).
 * @param {string[]} paths
 * @param {{exists?: (f: string) => boolean}} [options]
 * @returns {'pytest'|'vitest'|null}
 */
export function detectFramework(paths, options = {}) {
  const isPy = (p) => p.endsWith('.py');
  const isJsTest = (p) => /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p);
  const isJs = (p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p);

  // 1) An explicitly named file's extension wins.
  if (paths.some(isPy)) return 'pytest';
  if (paths.some(isJs)) return 'vitest';

  // 2) Otherwise scan the target's own contents (NOT cwd, which may hold an
  //    unrelated config in a monorepo/this test harness).
  const readdir = options.readdir || defaultReaddir;
  for (const p of paths) {
    const files = readdir(p);
    if (files.some(isPy)) return 'pytest';
    if (files.some(isJsTest)) return 'vitest';
  }

  // 3) Last resort: config-file markers.
  const exists = options.exists || ((f) => fs.existsSync(f));
  if (
    ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs'].some(exists)
  ) {
    return 'vitest';
  }
  if (
    ['pytest.ini', 'pyproject.toml', 'conftest.py', 'setup.cfg'].some(exists)
  ) {
    return 'pytest';
  }
  return null;
}

// Shallow-recursive file listing of a directory (bounded; skips vendor dirs).
// Returns [] for a non-directory or on error.
function defaultReaddir(root, depth = 3) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = `${root}/${e.name}`;
    if (e.isFile()) out.push(full);
    else if (e.isDirectory() && depth > 0)
      out.push(...defaultReaddir(full, depth - 1));
  }
  return out;
}

const vitestBase = (paths, junitPath) => [
  'npx',
  'vitest',
  'run',
  ...paths,
  '--reporter=junit',
  `--outputFile=${junitPath}`,
];

/** In-order vitest baseline (declared order; no shuffle). */
export function buildVitestBaselineCmd(paths, junitPath) {
  return vitestBase(paths, junitPath);
}

/** Shuffled vitest run with a pinned seed (built-in, no plugin needed). */
export function buildVitestShuffleCmd(paths, junitPath, seed) {
  return [
    ...vitestBase(paths, junitPath),
    '--sequence.shuffle',
    `--sequence.seed=${seed}`,
  ];
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
 * @typedef {Object} ConfirmResult
 * @property {string} status 'ok' | 'no_plugin' | 'baseline_red' | 'unknown_framework'
 * @property {number} seed
 * @property {'pytest'|'vitest'|null} [framework]
 * @property {string|null} plugin
 * @property {{victim: string, classification: string}[]} victims
 * @property {{victim: string, classification: string}[]} nondeterministic
 * @property {string[]} baselineFailures
 * @property {string} reproduce
 * @property {string[]} [order]
 * @property {string} [message]
 */

/**
 * Orchestrate the dynamic confirmation.
 * @param {string[]} paths
 * @param {{seed: number, plugin?: string|null,
 *          framework?: 'pytest'|'vitest',
 *          runSuite?: (cmd: string[]) => Record<string,string>,
 *          probe?: (name: string) => boolean}} [options]
 * @returns {ConfirmResult}
 */
export function confirm(paths, options = {}) {
  const { seed, runSuite, probe } = options;
  // Passing an explicit plugin (Phase 2/3 call sites) implies pytest; otherwise
  // detect from the paths. The test cwd owns a vitest.config, so relying on
  // detection alone there would misroute pytest cases.
  const framework =
    options.framework ??
    (options.plugin !== undefined ? 'pytest' : detectFramework(paths));

  const base = {
    status: 'ok',
    seed,
    framework,
    plugin: null,
    victims: [],
    nondeterministic: [],
    baselineFailures: [],
    reproduce: '',
  };

  if (framework !== 'pytest' && framework !== 'vitest') {
    return {
      ...base,
      status: 'unknown_framework',
      message:
        'Could not detect pytest or vitest for the given paths. ' +
        'Pass the framework explicitly to run Tier 2.',
    };
  }

  // A temp path is only needed by the real runner; the injected stub ignores it.
  const junit = TMP_JUNIT;
  const run = runSuite || ((cmd) => runPytestSuite(cmd, junit));

  let baselineCmd;
  let shuffleCmd;
  if (framework === 'vitest') {
    // vitest shuffle is built in - no plugin gate.
    baselineCmd = buildVitestBaselineCmd(paths, junit);
    shuffleCmd = buildVitestShuffleCmd(paths, junit, seed);
  } else {
    const plugin =
      options.plugin !== undefined
        ? options.plugin
        : detectShufflePlugin(probe);
    base.plugin = plugin;
    if (!plugin) {
      return {
        ...base,
        status: 'no_plugin',
        message:
          'Tier 2 needs a pytest shuffle plugin. Install pytest-randomly (or ' +
          'pytest-random-order) to enable order-dependence confirmation.',
      };
    }
    baselineCmd = buildBaselineCmd(paths, junit, plugin);
    shuffleCmd = buildShuffleCmd(paths, junit, seed, plugin);
  }

  const baseline = run(baselineCmd);
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

  const s1 = run(shuffleCmd);
  const s2 = run(shuffleCmd);
  const findings = classify(baseline, s1, s2, seed);

  return {
    ...base,
    victims: findings.filter((f) => f.classification === 'order-dependent'),
    nondeterministic: findings.filter(
      (f) => f.classification === 'nondeterministic',
    ),
    reproduce: shuffleCmd.join(' '),
    // Shuffled execution order (JUnit testcase order under the seed). Phase 3
    // uses this to derive each victim's prefix for polluter bisection.
    order: Object.keys(s1),
  };
}

// ---------------------------------------------------------------------------
// Phase 3: isolation re-run + polluter bisect (name the culprit, not just the
// victim). Algorithms are pure; the subprocess seams live in realPolluterSeams.
// ---------------------------------------------------------------------------

/** True when the victim passed every alone-run - i.e. the leak is external. */
export function isolationConfirms(outcomes) {
  return outcomes.length > 0 && outcomes.every((o) => o === 'passed');
}

/**
 * Binary-search the ordered prefix for the single test whose presence flips
 * the victim from pass to fail. `reproduces(subset)` returns whether the victim
 * fails when exactly `subset` (in order) runs before it.
 *
 * Assumes near-monotonic reproduction (a single polluter). When that does not
 * hold, the invariant check fails and we report the smallest reproducing prefix
 * with `polluter: null, exhausted: true` rather than blame the wrong test.
 *
 * @param {string[]} prefix ordered test ids that ran before the victim
 * @param {(subset: string[]) => boolean} reproduces
 * @param {{maxSteps?: number}} [options]
 */
export function bisectPolluter(prefix, reproduces, options = {}) {
  const n = prefix.length;
  const maxSteps = options.maxSteps ?? Math.ceil(Math.log2(Math.max(2, n))) + 2;
  let steps = 0;
  const rep = (len) => {
    steps += 1;
    return reproduces(prefix.slice(0, len));
  };
  // Lower-bound search: smallest L in [1..n] whose prefix reproduces.
  let lo = 1;
  let hi = n;
  while (lo < hi && steps < maxSteps) {
    const mid = (lo + hi) >> 1;
    if (rep(mid)) hi = mid;
    else lo = mid + 1;
  }
  const minimalPrefix = prefix.slice(0, lo);
  const atLo = rep(lo);
  const below = lo > 1 ? rep(lo - 1) : false;
  if (atLo && !below) {
    return { polluter: prefix[lo - 1], minimalPrefix, steps, exhausted: false };
  }
  return { polluter: null, minimalPrefix, steps, exhausted: true };
}

/** Run one test alone, in-order, capturing its outcome. */
export function buildIsolateCmd(victimNodeId, junitPath) {
  return [
    'python3',
    '-m',
    'pytest',
    victimNodeId,
    '-p',
    'no:randomly',
    '--tb=no',
    '-q',
    `--junitxml=${junitPath}`,
  ];
}

/** Run an explicit ordered set of node ids in the given order (no shuffle). */
export function buildOrderedSubsetCmd(nodeIds, junitPath) {
  return [
    'python3',
    '-m',
    'pytest',
    ...nodeIds,
    '-p',
    'no:randomly',
    '--tb=no',
    '-q',
    `--junitxml=${junitPath}`,
  ];
}

/**
 * @typedef {Object} EnrichedVictim
 * @property {string} victim
 * @property {string} classification
 * @property {boolean} [passesAlone]
 * @property {string|null} [polluter]
 * @property {string} [note]
 * @property {string[]} [minimalPrefix]
 * @property {number} [bisectSteps]
 * @property {boolean} [exhausted]
 * @property {string} [reproduce]
 */

/**
 * Enrich each order-dependent victim with an isolation verdict and, when it
 * passes alone, the bisected polluter.
 * @param {{victim: string, classification: string}[]} victims
 * @param {string[]} order shuffled execution order (from confirm().order)
 * @param {{runVictimAlone: (v: string) => string,
 *          reproducesInPrefix: (prefix: string[], v: string) => boolean,
 *          isolateRepeats?: number, bisectMaxSteps?: number}} seams
 * @returns {EnrichedVictim[]}
 */
export function locatePolluters(victims, order, seams) {
  const { runVictimAlone, reproducesInPrefix } = seams;
  const isolateRepeats = seams.isolateRepeats ?? 3;
  return victims.map((v) => {
    const idx = order.indexOf(v.victim);
    const prefix = idx > 0 ? order.slice(0, idx) : [];
    const alone = Array.from({ length: isolateRepeats }, () =>
      runVictimAlone(v.victim),
    );
    if (!isolationConfirms(alone)) {
      return {
        ...v,
        passesAlone: false,
        polluter: null,
        note: 'fails in isolation - the test is broken or flaky on its own, not an order-leak victim',
      };
    }
    if (prefix.length === 0) {
      return {
        ...v,
        passesAlone: true,
        polluter: null,
        note: 'ran first under this seed - no earlier test to blame',
      };
    }
    const b = bisectPolluter(
      prefix,
      (subset) => reproducesInPrefix(subset, v.victim),
      { maxSteps: seams.bisectMaxSteps },
    );
    return {
      ...v,
      passesAlone: true,
      polluter: b.polluter,
      minimalPrefix: b.minimalPrefix,
      bisectSteps: b.steps,
      exhausted: b.exhausted,
      reproduce: b.polluter
        ? `python3 -m pytest -p no:randomly ${b.polluter} ${v.victim}`
        : undefined,
    };
  });
}

/**
 * Convert a pytest node id (`path/to/file.py::Class::name`) to the JUnit key
 * pytest reports for it (`path.to.file.Class::name`). Deterministic, so a map
 * built from `--collect-only` correctly translates a canonical (report) id back
 * to a runnable node id - including class-based layouts (the Phase 3 gap).
 * @param {string} nodeId
 */
export function nodeIdToKey(nodeId) {
  const parts = nodeId.split('::');
  const file = parts[0];
  const rest = parts.slice(1);
  const name = rest[rest.length - 1];
  const classSegs = rest.slice(0, -1);
  const module = file.replace(/\.py$/, '').replace(/\//g, '.');
  return `${[module, ...classSegs].join('.')}::${name}`;
}

/**
 * Map each canonical JUnit key to its runnable pytest node id.
 * @param {string[]} nodeIds
 * @returns {Record<string, string>}
 */
export function buildNodeIdMap(nodeIds) {
  const map = {};
  for (const id of nodeIds) map[nodeIdToKey(id)] = id;
  return map;
}

/** Run pytest --collect-only and return the authoritative node ids. */
export function collectPytestNodeIds(paths) {
  const res = spawnSync(
    'python3',
    [
      '-m',
      'pytest',
      ...paths,
      '--collect-only',
      '-q',
      '-p',
      'no:cacheprovider',
    ],
    { encoding: 'utf8' },
  );
  return (res.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('::') && !l.includes(' '));
}

// Fallback when a node id is absent from the collect map (function-level: the
// dotted classname is the module path, so dots -> slashes + `.py` recovers it).
function canonicalToNodeId(id) {
  const i = id.lastIndexOf('::');
  if (i < 0) return id;
  return `${id.slice(0, i).replace(/\./g, '/')}.py::${id.slice(i + 2)}`;
}

function outcomeFor(outcomes, id) {
  if (id in outcomes) return outcomes[id];
  const name = id.slice(id.lastIndexOf('::') + 2);
  const key = Object.keys(outcomes).find((k) => k.endsWith(`::${name}`));
  return key ? outcomes[key] : undefined;
}

/**
 * Real subprocess seams for locatePolluters (pytest; needs no shuffle plugin).
 * A node-id map from `--collect-only` translates canonical report ids to
 * runnable node ids, so class-based layouts re-run correctly.
 * @param {string[]} [paths] target paths (enables the collect-only node-id map)
 * @param {string} [junitPath]
 */
export function realPolluterSeams(paths = [], junitPath = TMP_POLLUTER) {
  const map = paths.length ? buildNodeIdMap(collectPytestNodeIds(paths)) : {};
  const toNodeId = (id) => map[id] || canonicalToNodeId(id);
  return {
    isolateRepeats: 3,
    runVictimAlone: (victim) => {
      const out = runPytestSuite(
        buildIsolateCmd(toNodeId(victim), junitPath),
        junitPath,
      );
      return outcomeFor(out, victim);
    },
    reproducesInPrefix: (prefix, victim) => {
      const ids = [...prefix, victim].map(toNodeId);
      const out = runPytestSuite(
        buildOrderedSubsetCmd(ids, junitPath),
        junitPath,
      );
      return FAILED.has(outcomeFor(out, victim));
    },
  };
}
