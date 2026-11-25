/**
 * The mutation run itself (#486 slice 2, #1380 gap 2).
 *
 * Every way the run can fail to produce a report has to end in an abstention
 * that says why. Before this slice a crash or a timeout left nothing behind,
 * so the run simply disappeared -- and a check that disappears reads, to the
 * person skimming the PR, exactly like one that passed.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RUNNER_ISSUE } from '../src/guardian/mutation.js';
import {
  defaultMutationEngine,
  type MutationEngine,
} from '../src/guardian/mutation-engine.js';
import { runMutation, type RunOptions } from '../src/guardian/mutation-run.js';

/** A ts/ root holding one source file, returned with its path. */
function tsRoot(source = 'export const a = 1;\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'canary-mutation-run-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), source);
  return root;
}

function options(root: string, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    tsRoot: root,
    units: [{ path: 'ts/src/a.ts', added_ranges: [[1, 1]] }],
    runnerVersion: '10.1.1',
    vitestVersion: '5.1.1',
    timeoutMs: 60_000,
    ...extra,
  };
}

/** An engine whose count and run are scripted; it records the config path. */
function fakeEngine(
  over: Partial<MutationEngine> = {},
): MutationEngine & { configs: string[] } {
  const configs: string[] = [];
  return {
    configs,
    countMutants: () =>
      Promise.resolve([{ path: 'src/a.ts', line: 1, mutants: 3 }]),
    runStryker: (configPath) => {
      configs.push(configPath);
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        jsonReporter: { fileName: string };
      };
      writeFileSync(config.jsonReporter.fileName, '{"files":{}}');
      return { code: 0, timedOut: false, detail: '' };
    },
    ...over,
  };
}

describe('runMutation abstentions', () => {
  it('abstains on a runner that cannot kill mutants, without running anything', async () => {
    const engine = fakeEngine();
    const result = await runMutation(
      options(tsRoot(), { runnerVersion: '10.0.0' }),
      engine,
    );
    expect(result.kind).toBe('abstained');
    expect(result.kind === 'abstained' && result.reason).toContain(
      RUNNER_ISSUE,
    );
    expect(engine.configs).toEqual([]);
  });

  it('abstains when the diff adds nothing Stryker can mutate', async () => {
    const result = await runMutation(
      options(tsRoot(), {
        units: [{ path: 'docs/a.md', added_ranges: [[1, 1]] }],
      }),
      fakeEngine(),
    );
    expect(result).toMatchObject({ kind: 'abstained' });
    expect(result.kind === 'abstained' && result.reason).toMatch(/ts\/src/);
  });

  it('abstains, never throws, when the diff names a source not on disk', async () => {
    // A throw here would escape to the CLI and exit 1 -- which ADR 0009 reads
    // as "survivors". A stale diff is not a weak test.
    const result = await runMutation(
      options(tsRoot(), {
        units: [{ path: 'ts/src/gone.ts', added_ranges: [[1, 1]] }],
      }),
      fakeEngine(),
    );
    expect(result.kind === 'abstained' && result.reason).toMatch(
      /not on disk: src\/gone\.ts/,
    );
  });

  it('abstains, never throws, when counting mutants fails', async () => {
    const result = await runMutation(
      options(tsRoot()),
      fakeEngine({ countMutants: () => Promise.reject(new Error('parse')) }),
    );
    expect(result.kind === 'abstained' && result.reason).toBe(
      'counting mutants failed: parse',
    );
  });

  it('abstains when the instrumenter cannot be loaded', async () => {
    const result = await runMutation(
      options(tsRoot()),
      fakeEngine({ countMutants: () => Promise.resolve(null) }),
    );
    expect(result.kind === 'abstained' && result.reason).toMatch(
      /instrumenter/,
    );
  });

  it('abstains when the added lines produce zero mutants (type-only edits)', async () => {
    const result = await runMutation(
      options(tsRoot()),
      fakeEngine({ countMutants: () => Promise.resolve([]) }),
    );
    expect(result.kind === 'abstained' && result.reason).toMatch(
      /zero mutants/,
    );
  });

  it('abstains on a timeout, naming the budget (#1380 gap 2)', async () => {
    const result = await runMutation(
      options(tsRoot(), { timeoutMs: 1234 }),
      fakeEngine({
        runStryker: () => ({ code: null, timedOut: true, detail: '' }),
      }),
    );
    expect(result.kind === 'abstained' && result.reason).toMatch(
      /did not finish within 1\.2s/,
    );
  });

  it('abstains on a crash with Stryker’s last words (#1380 gap 2)', async () => {
    const result = await runMutation(
      options(tsRoot()),
      fakeEngine({
        runStryker: () => ({
          code: 1,
          timedOut: false,
          detail: 'There were failed tests in the initial test run.',
        }),
      }),
    );
    expect(result.kind === 'abstained' && result.reason).toContain(
      'exited 1: There were failed tests in the initial test run.',
    );
  });

  it('abstains when Stryker exits 0 but writes no report', async () => {
    const result = await runMutation(
      options(tsRoot()),
      fakeEngine({
        runStryker: () => ({ code: 0, timedOut: false, detail: '' }),
      }),
    );
    expect(result.kind === 'abstained' && result.reason).toMatch(
      /no JSON report/,
    );
  });
});

describe('runMutation run', () => {
  it('runs Stryker on the sampled lines with the slice-2 configuration', async () => {
    const engine = fakeEngine();
    const result = await runMutation(options(tsRoot()), engine);
    expect(result).toMatchObject({ kind: 'ran', generated: 3 });
    const config = JSON.parse(readFileSync(engine.configs[0]!, 'utf-8'));
    expect(config).toMatchObject({
      testRunner: 'vitest',
      coverageAnalysis: 'perTest',
      mutate: ['src/a.ts:1-1'],
      reporters: ['json'],
      inPlace: true,
      // With inPlace, the default prepends `// @ts-nocheck` to every src and
      // test file IN THE WORKING TREE -- far beyond the snapshotted targets --
      // and shifted every line of the instrumenter fixture by one.
      disableTypeChecks: false,
      vitest: { pool: 'forks', related: true },
      mutator: { excludedMutations: ['StringLiteral', 'ObjectLiteral'] },
    });
  });

  it('hands Stryker the diff’s own ranges when nothing was capped', async () => {
    // Line-only ranges lost multi-line mutants on the first real run.
    const engine = fakeEngine();
    await runMutation(
      options(tsRoot(), {
        units: [{ path: 'ts/src/a.ts', added_ranges: [[1, 5]] }],
      }),
      engine,
    );
    const config = JSON.parse(readFileSync(engine.configs[0]!, 'utf-8'));
    expect(config.mutate).toEqual(['src/a.ts:1-5']);
  });

  it('counts multi-line mutants with their end line from the real instrumenter', async () => {
    const counts = await defaultMutationEngine.countMutants(
      [{ path: 'test/fixtures/mutation-run/sample.ts', ranges: [[3, 3]] }],
      process.cwd(),
    );
    for (const c of counts!) expect(c.endLine).toBeGreaterThanOrEqual(c.line);
  });

  it('restores a target file a killed run left mutated, byte for byte', async () => {
    const original = 'export const a = 1;\n';
    const root = tsRoot(original);
    const result = await runMutation(
      options(root),
      fakeEngine({
        runStryker: () => {
          writeFileSync(join(root, 'src', 'a.ts'), 'MUTATED');
          return { code: null, timedOut: true, detail: '' };
        },
      }),
    );
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toBe(original);
    expect(result.restored).toEqual(['src/a.ts']);
  });

  it('removes the stryker-setup files a killed run leaves, and only those', async () => {
    // A real timed-out run left ts/stryker-setup-0..8.js behind, untracked
    // and unignored: one `git add -A` from being committed.
    const root = tsRoot();
    writeFileSync(join(root, 'stryker-setup-9.js'), 'pre-existing');
    await runMutation(
      options(root),
      fakeEngine({
        runStryker: () => {
          writeFileSync(join(root, 'stryker-setup-0.js'), 'left behind');
          return { code: null, timedOut: true, detail: '' };
        },
      }),
    );
    expect(existsSync(join(root, 'stryker-setup-0.js'))).toBe(false);
    expect(readFileSync(join(root, 'stryker-setup-9.js'), 'utf-8')).toBe(
      'pre-existing',
    );
  });

  it('removes its work directory when the run abstains', async () => {
    // Every run leaked one; a dogfood session left 237 behind in $TMPDIR.
    const engine = fakeEngine({
      runStryker: (configPath) => {
        engine.configs.push(configPath);
        return { code: 1, timedOut: false, detail: 'boom' };
      },
    });
    await runMutation(options(tsRoot()), engine);
    expect(existsSync(dirname(engine.configs[0]!))).toBe(false);
  });

  it('restores nothing after a clean run', async () => {
    const result = await runMutation(options(tsRoot()), fakeEngine());
    expect(result.restored).toEqual([]);
  });
});

describe('defaultMutationEngine', () => {
  it('counts mutants per line with Stryker’s own instrumenter, excluded mutators as ignored', async () => {
    const counts = await defaultMutationEngine.countMutants(
      [{ path: 'test/fixtures/mutation-run/sample.ts', ranges: [[3, 4]] }],
      process.cwd(),
    );
    expect(counts).not.toBeNull();
    // Looked up by line, never by position: the dogfood run under Stryker
    // returned these in a different order and failed the dry run.
    const gate = counts!.find((c) => c.line === 3);
    const label = counts!.find((c) => c.line === 4);
    expect(gate).toMatchObject({ ignored: 0 });
    expect(gate!.mutants).toBeGreaterThan(0);
    // Line 4 is a bare string: StringLiteral is excluded (D8), so its one
    // mutant is ignored -- counted for the total, never run.
    expect(label).toMatchObject({ mutants: 0, ignored: 1 });
    expect(counts!.map((c) => c.line)).toEqual([3, 4]);
  });

  it('returns counts ordered by path, then line, across files', async () => {
    // Fixture copies in a root whose node_modules is this install's.
    const root = mkdtempSync(
      join(process.cwd(), 'test', 'fixtures', 'mutation-run', 'tmp-'),
    );
    try {
      const src = readFileSync('test/fixtures/mutation-run/sample.ts', 'utf-8');
      const rel = root.slice(process.cwd().length + 1);
      writeFileSync(join(root, 'b.ts'), src);
      writeFileSync(join(root, 'a.ts'), `\n\n${src}`);
      const counts = await defaultMutationEngine.countMutants(
        [
          { path: `${rel}/b.ts`, ranges: [[3, 3]] },
          { path: `${rel}/a.ts`, ranges: [[5, 5]] },
        ],
        process.cwd(),
      );
      expect(
        counts!.map((c) => [c.path.slice(rel.length + 1), c.line]),
      ).toEqual([
        ['a.ts', 5],
        ['b.ts', 3],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a relative ts/ root, the CLI default (`--repo-root .`)', async () => {
    // createRequire() rejects a relative path; the first real run abstained
    // with "instrumenter could not be loaded" on exactly this.
    const counts = await defaultMutationEngine.countMutants(
      [{ path: 'test/fixtures/mutation-run/sample.ts', ranges: [[3, 3]] }],
      '.',
    );
    expect(counts).not.toBeNull();
  });

  it('returns null rather than throwing when the instrumenter is not installed', async () => {
    const counts = await defaultMutationEngine.countMutants(
      [{ path: 'src/a.ts', ranges: [[1, 1]] }],
      tsRoot(),
    );
    expect(counts).toBeNull();
  });

  /** A ts/ root whose `@stryker-mutator/core` bin is a scripted stand-in. */
  function fakeStrykerRoot(script: string): string {
    const root = tsRoot();
    const core = join(root, 'node_modules', '@stryker-mutator', 'core');
    mkdirSync(join(core, 'bin'), { recursive: true });
    writeFileSync(
      join(core, 'package.json'),
      JSON.stringify({ name: '@stryker-mutator/core', version: '10.1.1' }),
    );
    writeFileSync(join(core, 'bin', 'stryker.js'), script);
    chmodSync(join(core, 'bin', 'stryker.js'), 0o755);
    return root;
  }

  it('reports the exit code and the tail of the output', () => {
    const root = fakeStrykerRoot(
      'console.error("first line"); console.error("ConfigError: boom"); process.exit(1);',
    );
    const outcome = defaultMutationEngine.runStryker('cfg.json', root, 10_000);
    expect(outcome).toMatchObject({ code: 1, timedOut: false });
    expect(outcome.detail).toBe('ConfigError: boom');
  });

  it('reports the error line, not the Node.js version banner printed after it', () => {
    // A real crash ended "...ConfigError: ...\n    at ...\n\nNode.js v22.23.2",
    // and the abstain reason read "Stryker exited 1: Node.js v22.23.2".
    const root = fakeStrykerRoot(
      [
        'console.error("ConfigError: There were failed tests in the initial test run.");',
        'console.error("    at DryRunExecutor.validate (x.js:1:1)");',
        'console.error("  innerError: undefined");',
        'console.error("}");',
        'console.error("");',
        'console.error("Node.js " + process.version);',
        'process.exit(1);',
      ].join('\n'),
    );
    const outcome = defaultMutationEngine.runStryker('cfg.json', root, 10_000);
    expect(outcome.detail).toBe(
      'ConfigError: There were failed tests in the initial test run.',
    );
  });

  it('reports a timeout instead of an exit code', () => {
    const root = fakeStrykerRoot('setTimeout(() => {}, 10_000);');
    const outcome = defaultMutationEngine.runStryker('cfg.json', root, 200);
    expect(outcome.timedOut).toBe(true);
  });

  it('reports a missing Stryker as a crash, not a throw', () => {
    const outcome = defaultMutationEngine.runStryker(
      'cfg.json',
      tsRoot(),
      1_000,
    );
    expect(outcome.code).not.toBe(0);
    expect(outcome.detail).toMatch(/@stryker-mutator\/core/);
  });
});
