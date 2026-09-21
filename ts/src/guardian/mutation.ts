/**
 * Diff-scoped mutation testing (#486), tool-independent core.
 *
 * Coverage proves a test RAN. A mutation proves a test would FAIL if the code
 * were wrong. This module holds the model and the runner guard; the mapping of
 * a Stryker JSON report onto a guardian-shaped verdict, with its abstention and
 * suppression rules, lives in `mutation-report.ts`.
 *
 * Scope-building (turning a diff into Stryker `mutate` entries) and the D7
 * mutant cap are deliberately NOT here. They were written ahead of a runner
 * that is still not wired, so nothing called them; speculative scaffolding that
 * a real runner will redesign anyway is carrying cost for no verification.
 * Re-add them against an actual `mutate` entry format when the run lands.
 *
 * WHY THE RUN ITSELF IS NOT HERE. The 2026-09-17 spike found that
 * `@stryker-mutator/vitest-runner` 10.0.0 cannot kill mutants on vitest 5: it
 * builds vitest's `testNamePattern` by joining describe/test names with a
 * space, vitest 5 matches on `' > '`, so every mutant run executes zero tests
 * and every covered mutant reports "Survived" (upstream stryker-js#6210). A
 * check that prints confident false survivors is worse than no check, so
 * {@link runnerCompatibility} gates the run and the caller abstains. Fork F6 on
 * issue #486 recorded that decision.
 *
 * The second spike finding shapes {@link threadUnsafeTests}: the runner forces
 * `pool: 'threads'` and `process.chdir()` does not exist in a worker thread, so
 * every suite that changes directory has to be excluded from a mutation run. A
 * mutant only an excluded suite would kill therefore reads as `survived` -- a
 * false survivor by construction. Every report discloses that list, because a
 * precision number quoted without it would be a number about nothing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The upstream bug that makes a vitest-5 mutation run untrustworthy. */
export const RUNNER_ISSUE = 'stryker-js#6210';

/**
 * The newest `@stryker-mutator/vitest-runner` known to carry the #6210
 * name-join bug. Anything strictly newer is assumed fixed; revising this is a
 * one-line change plus its test, which is why it is data rather than a branch.
 */
export const BROKEN_RUNNER_MAX = '10.0.0';

/** The first vitest major whose per-test name filter joins names with ' > '. */
export const FIRST_AFFECTED_VITEST_MAJOR = 5;

/** Markers identifying a suite that cannot run inside a worker thread. */
const THREAD_UNSAFE_MARKERS = [
  'process.chdir',
  'guardian-cli-testkit',
  'canary-cli-testkit',
];

/** How a mutant ended up, in guardian's vocabulary rather than Stryker's. */
export type MutationStatus = 'killed' | 'survived' | 'no-coverage' | 'timeout';

/** The overall answer. `abstained` is never a pass and never a failure. */
export type MutationVerdict = 'survivors' | 'all-killed' | 'abstained';

/** One mutant, and the tests that ran over it without noticing. */
export interface MutantFinding {
  path: string;
  line: number;
  /** Stryker's mutator name, e.g. `ConditionalExpression`. */
  mutator: string;
  /** The mutated source snippet. */
  replacement: string;
  status: MutationStatus;
  /** Test names that covered the mutant but did not fail. */
  coveredBy: string[];
}

/** A survivor the author accepted in writing, with the reason they gave. */
export interface SuppressedMutant {
  finding: MutantFinding;
  reason: string;
}

/** The guardian-shaped verdict for one mutation run. */
export interface MutationReport {
  verdict: MutationVerdict;
  abstainReason?: string;
  /** Mutants Stryker generated, before the D7 cap. */
  generated: number;
  /** Mutants actually run. Equal to `generated` unless the cap truncated. */
  sampled: number;
  killed: number;
  survived: number;
  /** Reported apart from survivors: a coverage gap, not a weak assertion. */
  noCoverage: number;
  timeout: number;
  findings: MutantFinding[];
  suppressed: SuppressedMutant[];
  /**
   * Suites excluded from the run because they cannot run in a worker thread.
   * Disclosed on EVERY report, abstentions included -- a survivor count read
   * without this list overstates what the run actually checked.
   */
  excludedTests: string[];
}

/** The subset of Stryker's JSON report schema this module consumes. */
export interface StrykerReport {
  schemaVersion?: string;
  files: Record<
    string,
    {
      language?: string;
      source?: string;
      mutants: Array<{
        id: string;
        mutatorName: string;
        replacement?: string;
        status: string;
        location: { start: { line: number; column: number } };
        coveredBy?: string[];
      }>;
    }
  >;
  testFiles?: Record<string, { tests: Array<{ id: string; name: string }> }>;
}

/** Whether the installed runner can be trusted to kill a mutant at all. */
export interface RunnerVerdict {
  compatible: boolean;
  reason?: string;
}

/** Options for {@link mapStrykerReport}. */
export interface MapOptions {
  excludedTests: string[];
  /** Pre-cap mutant count, when the caller sampled before running (D7). */
  generated?: number;
}

/** A parsed version: its major, and a rank that orders two versions. */
interface Version {
  major: number;
  rank: number;
}

/** Parse a leading `major.minor.patch`; `null` when it is not one. */
function parseVersion(version: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return null;
  const [major, minor, patch] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  return { major, rank: major * 1_000_000 + minor * 1_000 + patch };
}

/**
 * Decide whether a mutation run could produce a verdict worth reading.
 *
 * This is the guard that keeps #6210 from becoming a false green in reverse: an
 * incompatible pairing must abstain, because the runner reports every covered
 * mutant as "Survived" while running zero tests. An unknown version is
 * incompatible too -- guessing here is exactly the abstention this issue exists
 * to prevent.
 */
export function runnerCompatibility(
  runnerVersion: string | null,
  vitestVersion: string | null,
): RunnerVerdict {
  if (runnerVersion === null) {
    return {
      compatible: false,
      reason:
        '@stryker-mutator/vitest-runner is not installed, so no mutant was run',
    };
  }
  const runner = parseVersion(runnerVersion);
  const vitest = vitestVersion === null ? null : parseVersion(vitestVersion);
  if (runner === null || vitest === null) {
    return {
      compatible: false,
      reason:
        `cannot read the runner/vitest versions ` +
        `(runner ${runnerVersion}, vitest ${vitestVersion ?? 'unknown'})`,
    };
  }
  if (vitest.major < FIRST_AFFECTED_VITEST_MAJOR) return { compatible: true };
  if (runner.rank > parseVersion(BROKEN_RUNNER_MAX)!.rank) {
    return { compatible: true };
  }
  return {
    compatible: false,
    reason:
      `@stryker-mutator/vitest-runner ${runnerVersion} runs zero tests per ` +
      `mutant on vitest ${vitestVersion}, so every covered mutant would be ` +
      `reported as survived (${RUNNER_ISSUE})`,
  };
}

/** Recursively list `*.test.ts` files under `dir`; unreadable dirs yield none. */
function listTests(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listTests(full));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

/**
 * List the suites a Stryker run has to exclude, repo-relative to `root`.
 *
 * Stryker's vitest runner forces `pool: 'threads'`, and `process.chdir()` does
 * not exist in a worker thread, so any suite that changes directory -- directly
 * or through a CLI testkit -- fails the initial run and Stryker then refuses to
 * mutate anything. This list is what the report discloses (F6).
 */
export function threadUnsafeTests(root: string): string[] {
  const files = [
    ...listTests(join(root, 'src')),
    ...listTests(join(root, 'test')),
  ];
  return files
    .filter((file) => {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return false;
      }
      return THREAD_UNSAFE_MARKERS.some((marker) => text.includes(marker));
    })
    .map((file) => relative(root, file).split(sep).join('/'))
    .sort();
}
