/**
 * Denominator test for the `typecheck` gate (#759).
 *
 * `typecheck` is a required gate here, distinct from lint, and "typecheck
 * passes" is read as "the TypeScript in this repo compiles". It did not mean
 * that: `ts/tsconfig.json` declared `"include": ["src"]` with no `exclude`, and
 * `npm run typecheck` was `tsc -p . --noEmit`, so all 150+ files under
 * `ts/test/` were outside the gate entirely. A type error in a test could not
 * fail CI, and a `@ts-expect-error` in a test was decoration — nothing compiled
 * it, so nothing checked that the error it claimed to expect actually occurred.
 *
 * Same family as the entry-point and dependabot denominator tests: a check
 * reporting success over a set far smaller than a reader assumes.
 *
 * The invariants, all derived rather than hardcoded so the test cannot drift
 * away from what the script actually runs:
 *
 * 1. The `typecheck` script's project resolves to a config whose file list
 *    contains every git-tracked `.ts` file under `ts/test/`. Enumerated from
 *    git, not from a glob of the config, so shrinking the include set fails
 *    here instead of silently shrinking the denominator.
 *
 * 2. That same file list still contains `ts/src`. Widening to tests must not
 *    come at the cost of narrowing away from source.
 *
 * 3. The gate emits nothing. A typecheck that writes `dist` would make the
 *    gate and the build fight over the same output directory.
 *
 * 4. The *build* project (`tsc -p .` in the `build` script) still excludes the
 *    test tree. `rootDir` is `src` and `outDir` is `dist`; a build project that
 *    picked up `test/` would either fail on rootDir or emit compiled tests into
 *    the published tree. This is the reason the gate and the build do not share
 *    one config file, and it is the invariant that keeps them split.
 *
 * Offline: reads the tsconfigs through the TypeScript compiler API and asks git
 * for its index.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(TS_DIR, '..');

interface PackageJson {
  scripts?: Record<string, string>;
}

function scripts(): Record<string, string> {
  const pkg = JSON.parse(
    readFileSync(join(TS_DIR, 'package.json'), 'utf8'),
  ) as PackageJson;
  return pkg.scripts ?? {};
}

/**
 * Resolve the tsconfig a `tsc` invocation actually uses, from the script text.
 * `-p X` / `--project X` names it; a bare `.` means the directory's
 * `tsconfig.json`. Deriving this is the point — a test that hardcoded
 * `tsconfig.check.json` would keep passing after someone repointed the script.
 */
function projectOf(script: string): string {
  const match = /(?:-p|--project)\s+(\S+)/.exec(script);
  if (!match) {
    throw new Error(`no tsc project flag found in script: ${script}`);
  }
  const target = resolve(TS_DIR, match[1]!);
  return target.endsWith('.json') ? target : join(target, 'tsconfig.json');
}

function parse(configPath: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    undefined,
    ts.sys as unknown as ts.ParseConfigFileHost,
  );
  if (!parsed) {
    throw new Error(`could not parse tsconfig at ${configPath}`);
  }
  expect(
    parsed.errors.filter((e) => e.category === ts.DiagnosticCategory.Error),
  ).toEqual([]);
  return parsed;
}

/** Config file lists are absolute; normalise to repo-relative posix paths. */
function repoRelative(fileNames: readonly string[]): Set<string> {
  return new Set(
    fileNames.map((f) => relative(REPO_ROOT, f).split(sep).join('/')),
  );
}

/**
 * The one legitimate hole in the gate. `ts/test/fixtures/**` is sample INPUT —
 * files that deliberately import absent packages and reference undefined names
 * so that scanners and linters pointed at them have something to complain
 * about. Compiling them would assert the opposite of what they exist to prove.
 * Named here as a constant so that widening the exclusion is a visible edit to
 * this test rather than a quiet edit to a config.
 */
const FIXTURES = 'ts/test/fixtures/';

function trackedTestSources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--', 'ts/test/*.ts', 'ts/test/**/*.ts'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .filter((f) => !f.startsWith(FIXTURES));
}

describe('the typecheck gate covers the test tree (#759)', () => {
  const TYPECHECK = scripts().typecheck ?? '';
  const BUILD = scripts().build ?? '';

  it('has a typecheck script that invokes tsc on a project', () => {
    expect(TYPECHECK).toMatch(/\btsc\b/);
    expect(() => projectOf(TYPECHECK)).not.toThrow();
  });

  it('enumerates a non-empty set of tracked test sources', () => {
    // Guards this test's own denominator: a git call that returned nothing
    // would make every assertion below vacuously true.
    expect(trackedTestSources().length).toBeGreaterThan(100);
  });

  it('includes every tracked ts/test source file', () => {
    const covered = repoRelative(parse(projectOf(TYPECHECK)).fileNames);
    const missing = trackedTestSources().filter((f) => !covered.has(f));
    expect(missing).toEqual([]);
  });

  it('excludes nothing under ts/test except the fixtures directory', () => {
    // The exclusion above is only defensible while it stays that narrow. Read
    // back from the config so that adding a second `exclude` entry — the easy
    // way to make a newly-surfaced type error go away — fails here.
    const raw = ts.readConfigFile(projectOf(TYPECHECK), ts.sys.readFile)
      .config as {
      exclude?: string[];
    };
    expect(raw.exclude ?? []).toEqual(['test/fixtures']);
  });

  it('still includes ts/src', () => {
    const covered = [...repoRelative(parse(projectOf(TYPECHECK)).fileNames)];
    expect(
      covered.filter((f) => f.startsWith('ts/src/')).length,
    ).toBeGreaterThan(0);
  });

  it('emits nothing', () => {
    const parsed = parse(projectOf(TYPECHECK));
    const noEmit =
      parsed.options.noEmit === true || /--noEmit\b/.test(TYPECHECK);
    expect(noEmit).toBe(true);
  });

  it('keeps the build project free of the test tree', () => {
    const built = repoRelative(parse(projectOf(BUILD)).fileNames);
    const leaked = [...built].filter((f) => f.startsWith('ts/test/'));
    expect(leaked).toEqual([]);
  });
});
