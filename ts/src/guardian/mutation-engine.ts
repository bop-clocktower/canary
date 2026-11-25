/**
 * The side-effecting half of the mutation run (#486 slice 2): counting
 * mutants with Stryker's own instrumenter, and spawning Stryker.
 *
 * Split from `mutation-run.ts` to keep both inside the 300-line perf budget,
 * and because this is the half tests replace: `runMutation` takes any
 * {@link MutationEngine}, so its abstentions are tested without a Stryker run.
 *
 * Both steps resolve packages from the `ts/` install the version guard
 * probed, never from canary's own location, so the guard and the run can
 * never be talking about two different Strykers.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EXCLUDED_MUTATORS,
  type LineCount,
  type MutationTarget,
} from './mutation-scope.js';

/** How a Stryker process ended. `code` is `null` when it was killed. */
export interface StrykerOutcome {
  code: number | null;
  timedOut: boolean;
  /** The last line Stryker printed, for the abstain reason. */
  detail: string;
}

/** The two side-effecting steps, injected so tests never spawn Stryker. */
export interface MutationEngine {
  /** Mutants per added line; `null` when the instrumenter cannot be loaded. */
  countMutants(
    targets: MutationTarget[],
    tsRoot: string,
  ): Promise<LineCount[] | null>;
  runStryker(
    configPath: string,
    tsRoot: string,
    timeoutMs: number,
  ): StrykerOutcome;
}

const off = (): boolean => false;
const ignore = (): void => undefined;

/**
 * A no-op logger the instrumenter accepts; it only logs on parse problems,
 * which surface as a thrown error the caller already turns into an abstention.
 */
const quietLogger = {
  isTraceEnabled: off,
  isDebugEnabled: off,
  isInfoEnabled: off,
  isWarnEnabled: off,
  isErrorEnabled: off,
  isFatalEnabled: off,
  trace: ignore,
  debug: ignore,
  info: ignore,
  warn: ignore,
  error: ignore,
  fatal: ignore,
};

interface InstrumentedMutant {
  fileName: string;
  status?: string;
  location: { start: { line: number }; end: { line: number } };
}

/**
 * A `require` that resolves packages installed in `tsRoot` -- the install the
 * version guard probed. `createRequire` rejects a relative path, and the CLI
 * default `--repo-root .` produces one.
 */
const requireFrom = (tsRoot: string): NodeJS.Require =>
  createRequire(join(resolve(tsRoot), 'package.json'));

/** Count mutants per 1-based line with the instrumenter installed in `tsRoot`. */
async function countWithInstrumenter(
  targets: MutationTarget[],
  tsRoot: string,
): Promise<LineCount[] | null> {
  let Instrumenter: new (logger: unknown) => {
    instrument(
      files: unknown[],
      options: unknown,
    ): Promise<{ mutants: readonly InstrumentedMutant[] }>;
  };
  try {
    const entry = requireFrom(tsRoot).resolve('@stryker-mutator/instrumenter');
    ({ Instrumenter } = await import(pathToFileURL(entry).href));
  } catch {
    return null;
  }
  // The instrumenter's lines are 0-based; the diff's are 1-based.
  const files = targets.map((target) => ({
    name: target.path,
    content: readFileSync(join(tsRoot, target.path), 'utf-8'),
    mutate: target.ranges.map(([start, end]) => ({
      start: { line: start - 1, column: 0 },
      end: { line: end - 1, column: Number.MAX_SAFE_INTEGER },
    })),
  }));
  const result = await new Instrumenter(quietLogger).instrument(files, {
    plugins: null,
    excludedMutations: EXCLUDED_MUTATORS,
    ignorers: [],
    noHeader: true,
  });
  const counts = new Map<string, Required<LineCount>>();
  for (const mutant of result.mutants) {
    const line = mutant.location.start.line + 1;
    const key = `${mutant.fileName}\0${line}`;
    const entry = counts.get(key) ?? {
      path: mutant.fileName,
      line,
      endLine: line,
      mutants: 0,
      ignored: 0,
    };
    // Excluded mutators come back `Ignored`; Stryker reports them as such.
    if (mutant.status === 'Ignored') entry.ignored += 1;
    else entry.mutants += 1;
    entry.endLine = Math.max(entry.endLine, mutant.location.end.line + 1);
    counts.set(key, entry);
  }
  // The instrumenter promises no order; callers and tests get (path, line).
  return [...counts.values()].sort((a, b) =>
    a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1,
  );
}

/** Spawn the Stryker installed in `tsRoot`, bounded by `timeoutMs`. */
function spawnStryker(
  configPath: string,
  tsRoot: string,
  timeoutMs: number,
): StrykerOutcome {
  let bin: string;
  try {
    const manifest = requireFrom(tsRoot).resolve(
      '@stryker-mutator/core/package.json',
    );
    bin = join(dirname(manifest), 'bin', 'stryker.js');
  } catch {
    return {
      code: 127,
      timedOut: false,
      detail: '@stryker-mutator/core is not installed',
    };
  }
  const res = spawnSync(process.execPath, [bin, 'run', configPath], {
    cwd: tsRoot,
    encoding: 'utf-8',
    timeout: timeoutMs,
    // SIGINT, not SIGTERM: it is the signal Stryker restores in-place files on.
    killSignal: 'SIGINT',
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut =
    (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return {
    code: timedOut ? null : res.status,
    timedOut,
    detail: lastWords(`${res.stdout ?? ''}\n${res.stderr ?? ''}`),
  };
}

/**
 * The line that says why Stryker stopped: the last `...Error: ...` line when
 * there is one, else the last line. Node prints its version banner AFTER an
 * uncaught error's stack, so "the last line" alone reads `Node.js v22.x`.
 */
function lastWords(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  // A class name (`ConfigError: ...`), not the error object's own
  // `innerError: undefined` field that the dump prints after it.
  const error = lines.filter((line) => /^[A-Z]\w*Error: /.test(line)).pop();
  return error ?? lines[lines.length - 1] ?? '';
}

/** The engine `canary guardian mutation` uses outside tests. */
export const defaultMutationEngine: MutationEngine = {
  countMutants: countWithInstrumenter,
  runStryker: spawnStryker,
};
