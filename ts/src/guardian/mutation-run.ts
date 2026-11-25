/**
 * Run Stryker on a PR's added lines (#486 slice 2).
 *
 * The 2026-09-17 spike shipped everything but this: the scope, the mapping and
 * the exit contract existed, and the run abstained behind the stryker-js#6210
 * guard. `@stryker-mutator/vitest-runner` 10.1.1 fixed #6210 and added a
 * `forks` pool, so the run can be trusted and the 108 suites that call
 * `process.chdir` no longer have to be excluded.
 *
 * `inPlace` is deliberate. Stryker's sandbox copies `ts/` only, so a suite that
 * reads a file from the repo root fails the dry run inside it. Mutating in
 * place means a run that is killed mid-mutant can leave a source file mutated,
 * so every run snapshots its target files first and restores exactly those
 * bytes afterwards -- never anything it did not snapshot.
 *
 * Every failure to produce a report is an abstention with a reason (#1380
 * gap 2); the caller maps a produced report and never sees a half-run.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChangedUnit } from './diff-coverage/types.js';
import { runnerCompatibility } from './mutation.js';
import type { MutationEngine, StrykerOutcome } from './mutation-engine.js';
import {
  EXCLUDED_MUTATORS,
  type MutationTarget,
  mutateEntries,
  mutationTargets,
  sampleLines,
} from './mutation-scope.js';

export interface RunOptions {
  /** The directory Stryker runs in: the repo's `ts/`. */
  tsRoot: string;
  /** The diff's added ranges, repo-relative (guardian's `scopeDiff`). */
  units: ChangedUnit[];
  runnerVersion: string | null;
  vitestVersion: string | null;
  /** Wall-clock budget for the Stryker process (D7). */
  timeoutMs: number;
  cap?: number;
}

/** Either a report to map, or the reason there is none. */
export type RunResult =
  | { kind: 'abstained'; reason: string; restored: string[] }
  | {
      kind: 'ran';
      /** Inside a temp work dir the caller removes once it has mapped this. */
      reportPath: string;
      generated: number;
      durationMs: number;
      restored: string[];
    };

/** The Stryker configuration for one run. */
export function strykerConfig(
  mutate: string[],
  reportFile: string,
  tempDir: string,
): Record<string, unknown> {
  return {
    testRunner: 'vitest',
    coverageAnalysis: 'perTest',
    mutate,
    reporters: ['json'],
    jsonReporter: { fileName: reportFile },
    mutator: { excludedMutations: EXCLUDED_MUTATORS },
    tempDirName: tempDir,
    inPlace: true,
    // Off, because of inPlace: the default prepends `// @ts-nocheck` to every
    // src and test file in the working tree, not just the snapshotted targets,
    // and shifts their lines. Vitest strips types without checking them, so
    // the header buys nothing here.
    disableTypeChecks: false,
    vitest: { configFile: 'vitest.config.ts', related: true, pool: 'forks' },
    logLevel: 'warn',
  };
}

/** Read every target file, so a killed run can be put back exactly. */
function snapshot(
  targets: MutationTarget[],
  tsRoot: string,
): Map<string, string> {
  const saved = new Map<string, string>();
  for (const target of targets) {
    saved.set(target.path, readFileSync(join(tsRoot, target.path), 'utf-8'));
  }
  return saved;
}

/** Write back any snapshotted file whose bytes changed; return those paths. */
function restore(saved: Map<string, string>, tsRoot: string): string[] {
  const restored: string[] = [];
  for (const [path, content] of saved) {
    const file = join(tsRoot, path);
    if (readFileSync(file, 'utf-8') !== content) {
      writeFileSync(file, content);
      restored.push(path);
    }
  }
  return restored;
}

/** The vitest runner's per-worker setup files, written into the cwd. */
const SETUP_FILE = /^stryker-setup-\d+\.js$/;

const setupFiles = (tsRoot: string): Set<string> =>
  new Set(readdirSync(tsRoot).filter((name) => SETUP_FILE.test(name)));

/**
 * Delete setup files that appeared during the run. Stryker removes them on a
 * clean exit; a killed run leaves them untracked in `ts/`, one `git add -A`
 * from a commit. Files that predate the run are not ours and stay.
 */
function removeNewSetupFiles(before: Set<string>, tsRoot: string): void {
  for (const name of setupFiles(tsRoot)) {
    if (!before.has(name)) rmSync(join(tsRoot, name), { force: true });
  }
}

/** Why a finished Stryker process produced nothing to map, else `null`. */
function failureReason(
  outcome: StrykerOutcome,
  timeoutMs: number,
  reportFile: string,
): string | null {
  if (outcome.timedOut) {
    return `Stryker did not finish within ${(timeoutMs / 1000).toFixed(1)}s (the D7 budget), so no mutant result was kept`;
  }
  if (outcome.code !== 0) {
    const detail = outcome.detail === '' ? '' : `: ${outcome.detail}`;
    return `Stryker exited ${outcome.code ?? 'on a signal'}${detail}`;
  }
  if (!existsSync(reportFile))
    return 'Stryker exited 0 but wrote no JSON report';
  return null;
}

/** Why the run cannot start, else `null`. */
async function planRun(
  opts: RunOptions,
  engine: MutationEngine,
): Promise<
  { reason: string } | { targets: MutationTarget[]; generated: number }
> {
  const verdict = runnerCompatibility(opts.runnerVersion, opts.vitestVersion);
  if (!verdict.compatible) return { reason: verdict.reason! };
  const targets = mutationTargets(opts.units);
  if (targets.length === 0) {
    return {
      reason: 'the diff adds no lines under ts/src that Stryker could mutate',
    };
  }
  // A stale diff can name a file this checkout does not have. Every read below
  // would throw, and an uncaught throw exits 1 -- "survivors" under ADR 0009.
  const missing = targets.filter((t) => !existsSync(join(opts.tsRoot, t.path)));
  if (missing.length > 0) {
    return {
      reason: `the diff names sources not on disk: ${missing.map((t) => t.path).join(', ')}`,
    };
  }
  let counts;
  try {
    counts = await engine.countMutants(targets, opts.tsRoot);
  } catch (error) {
    return { reason: `counting mutants failed: ${(error as Error).message}` };
  }
  if (counts === null) {
    return {
      reason:
        'the Stryker instrumenter could not be loaded, so no mutant was counted',
    };
  }
  const sample = sampleLines(counts, opts.cap);
  if (sample.planned === 0) {
    return {
      reason: "the diff's added lines under ts/src produce zero mutants",
    };
  }
  // Uncapped, the diff's own ranges go to Stryker unchanged, so it generates
  // exactly the mutants just counted.
  return {
    targets: sample.capped ? sample.targets : targets,
    generated: sample.generated,
  };
}

/** Plan, run and account for one mutation run. Never throws on a bad run. */
export async function runMutation(
  opts: RunOptions,
  engine: MutationEngine,
): Promise<RunResult> {
  const plan = await planRun(opts, engine);
  if ('reason' in plan)
    return { kind: 'abstained', reason: plan.reason, restored: [] };

  const workDir = mkdtempSync(join(tmpdir(), 'canary-mutation-'));
  const reportFile = join(workDir, 'stryker-report.json');
  const configPath = join(workDir, 'stryker.config.json');
  const config = strykerConfig(
    mutateEntries(plan.targets),
    reportFile,
    join(workDir, 'stryker-tmp'),
  );
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const saved = snapshot(plan.targets, opts.tsRoot);
  const setupBefore = setupFiles(opts.tsRoot);
  const started = Date.now();
  let outcome: StrykerOutcome;
  let restored: string[] = [];
  try {
    outcome = engine.runStryker(configPath, opts.tsRoot, opts.timeoutMs);
  } finally {
    // Restore before anything else can fail: a mutated source is the one
    // outcome worse than an abstention.
    restored = restore(saved, opts.tsRoot);
    removeNewSetupFiles(setupBefore, opts.tsRoot);
  }
  const reason = failureReason(outcome, opts.timeoutMs, reportFile);
  if (reason !== null) {
    rmSync(workDir, { recursive: true, force: true });
    return { kind: 'abstained', reason, restored };
  }
  return {
    kind: 'ran',
    reportPath: reportFile,
    generated: plan.generated,
    durationMs: Date.now() - started,
    restored,
  };
}
