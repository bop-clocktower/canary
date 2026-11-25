/**
 * `canary guardian mutation` with no `--report`: the real run (#486 slice 2).
 *
 * Covers the three #1380 gaps that live at the CLI: the run is scoped to the
 * diff (gap 3), a crash still leaves an abstained report behind (gap 2), and
 * the report reaches the PR as its own sticky comment, without touching the
 * guardian's (gap 1). Stryker never runs here: the engine is injected.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MutationEngine } from '../src/guardian/mutation-engine.js';
import { COMMENT_CHAR_BUDGET } from '../src/guardian/pr-check.js';
import { FakeGitHubClient, STICKY_MARKER } from '../src/guardian/pr-comment.js';
import { MUTATION_MARKER } from '../src/guardian/cli.js';

import { invokeGuardian, invokeGuardianJson } from './guardian-cli-testkit.js';

const SOURCE =
  'export const a = 1;\nexport const b = 2; // canary:allow-mutant equivalent mutant\n';

const DIFF = [
  'diff --git a/ts/src/a.ts b/ts/src/a.ts',
  '--- a/ts/src/a.ts',
  '+++ b/ts/src/a.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1;',
  '+export const b = 2; // canary:allow-mutant equivalent mutant',
  '',
].join('\n');

const CI_ENV = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'acme/widgets',
  GITHUB_REF: 'refs/pull/7/merge',
  GITHUB_TOKEN: 't',
};

/** A repo root with ts/src/a.ts, its diff file, and the runner manifests. */
function repo(): { root: string; diff: string } {
  const root = mkdtempSync(join(tmpdir(), 'canary-mutation-run-cli-'));
  mkdirSync(join(root, 'ts', 'src'), { recursive: true });
  writeFileSync(join(root, 'ts', 'src', 'a.ts'), SOURCE);
  for (const [pkg, version] of [
    ['@stryker-mutator/vitest-runner', '10.1.1'],
    ['vitest', '5.1.1'],
  ] as const) {
    const dir = join(root, 'ts', 'node_modules', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  }
  const diff = join(root, 'pr.diff');
  writeFileSync(diff, DIFF);
  return { root, diff };
}

type Mutant = { line: number; status: string; coveredBy?: string[] };

/**
 * An engine that "runs" Stryker by writing a report in Stryker's own shape:
 * paths relative to `ts/`, the directory Stryker ran in.
 */
function engine(
  mutants: Mutant[],
  over: Partial<MutationEngine> = {},
): MutationEngine {
  return {
    countMutants: () =>
      Promise.resolve([
        { path: 'src/a.ts', line: 1, mutants: 1 },
        { path: 'src/a.ts', line: 2, mutants: 1 },
      ]),
    runStryker: (configPath) => {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        jsonReporter: { fileName: string };
      };
      const report = {
        files: {
          'src/a.ts': {
            mutants: mutants.map((m, i) => ({
              id: String(i),
              mutatorName: 'ConditionalExpression',
              replacement: 'false',
              status: m.status,
              location: { start: { line: m.line, column: 1 } },
              coveredBy: m.coveredBy ?? ['t1'],
            })),
          },
        },
        testFiles: {
          'test/a.test.ts': { tests: [{ id: 't1', name: 'a covering test' }] },
        },
      };
      writeFileSync(config.jsonReporter.fileName, JSON.stringify(report));
      return { code: 0, timedOut: false, detail: '' };
    },
    ...over,
  };
}

function args(root: string, diff: string, extra: string[] = []): string[] {
  return ['mutation', '--repo-root', root, '--diff', diff, ...extra];
}

describe('guardian mutation run (no --report)', () => {
  it('maps a run onto repo-relative paths, so suppressions resolve', async () => {
    const { root, diff } = repo();
    const res = await invokeGuardianJson(args(root, diff, ['--json']), {
      deps: {
        mutationEngine: engine([
          { line: 1, status: 'Killed' },
          { line: 2, status: 'Survived' },
        ]),
      },
    });
    expect(res.verdict).toBe('all-killed');
    expect(res.killed).toBe(1);
    expect(res.suppressed).toMatchObject([
      {
        finding: { path: 'ts/src/a.ts', line: 2 },
        reason: 'equivalent mutant',
      },
    ]);
    expect(res.excludedTests).toEqual([]);
    expect(res.generated).toBe(2);
    expect(typeof res.durationMs).toBe('number');
  });

  it('removes the run’s work directory once the report is mapped', async () => {
    const { root, diff } = repo();
    const configs: string[] = [];
    const base = engine([{ line: 1, status: 'Killed' }]);
    await invokeGuardian(args(root, diff), {
      deps: {
        mutationEngine: {
          ...base,
          runStryker: (configPath, tsRoot, timeoutMs) => {
            configs.push(configPath);
            return base.runStryker(configPath, tsRoot, timeoutMs);
          },
        },
      },
    });
    expect(configs).toHaveLength(1);
    expect(existsSync(dirname(configs[0]!))).toBe(false);
  });

  it.each([
    [['--timeout-ms', '9000'], 9000],
    [[], 420_000],
    [['--timeout-ms', 'abc'], 420_000],
    [['--timeout-ms', '0'], 420_000],
    [['--timeout-ms', '-5'], 420_000],
    [['--timeout-ms', '1.5'], 420_000],
  ])('hands Stryker %j as a %i ms budget', async (flags, expected) => {
    const { root, diff } = repo();
    const seen: number[] = [];
    const base = engine([{ line: 1, status: 'Killed' }]);
    await invokeGuardian(args(root, diff, flags), {
      deps: {
        mutationEngine: {
          ...base,
          runStryker: (c, t, timeoutMs) => {
            seen.push(timeoutMs);
            return base.runStryker(c, t, timeoutMs);
          },
        },
      },
    });
    expect(seen).toEqual([expected]);
  });

  it('warns about restored sources only when it restored one', async () => {
    const { root, diff } = repo();
    const res = await invokeGuardian(args(root, diff), {
      deps: { mutationEngine: engine([{ line: 1, status: 'Killed' }]) },
    });
    expect(res.stderr).not.toContain('restored');
  });

  it('exits 1 on a survivor and names its test', async () => {
    const { root, diff } = repo();
    const res = await invokeGuardian(args(root, diff), {
      deps: { mutationEngine: engine([{ line: 1, status: 'Survived' }]) },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('`ts/src/a.ts:1`');
    expect(res.stdout).toContain('a covering test');
  });

  it('abstains on a docs-only diff without starting Stryker', async () => {
    const { root } = repo();
    const docs = join(root, 'docs.diff');
    writeFileSync(
      docs,
      'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -0,0 +1 @@\n+hi\n',
    );
    let ran = false;
    const res = await invokeGuardian(args(root, docs), {
      deps: {
        mutationEngine: engine([], {
          runStryker: () => {
            ran = true;
            return { code: 0, timedOut: false, detail: '' };
          },
        }),
      },
    });
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('adds no lines under ts/src');
    expect(ran).toBe(false);
  });

  it('a crash still writes an abstained report artifact (#1380 gap 2)', async () => {
    const { root, diff } = repo();
    const out = join(root, 'out', 'mutation-report.json');
    const res = await invokeGuardian(args(root, diff, ['--report-out', out]), {
      deps: {
        mutationEngine: engine([], {
          runStryker: () => ({ code: 1, timedOut: false, detail: 'boom' }),
        }),
      },
    });
    expect(res.code).toBe(3);
    const artifact = JSON.parse(readFileSync(out, 'utf-8'));
    expect(artifact.verdict).toBe('abstained');
    expect(artifact.abstainReason).toBe('Stryker exited 1: boom');
  });

  it('warns loudly when it had to restore a mutated source', async () => {
    const { root, diff } = repo();
    const res = await invokeGuardian(args(root, diff), {
      deps: {
        mutationEngine: engine([], {
          runStryker: () => {
            writeFileSync(join(root, 'ts', 'src', 'a.ts'), 'MUTATED');
            return { code: null, timedOut: true, detail: '' };
          },
        }),
      },
    });
    expect(res.code).toBe(3);
    expect(readFileSync(join(root, 'ts', 'src', 'a.ts'), 'utf-8')).toBe(SOURCE);
    expect(res.stderr).toContain('::warning');
    expect(res.stderr).toContain('ts/src/a.ts');
  });
});

describe('guardian mutation --post-comment (#1380 gap 1)', () => {
  it('posts its own sticky and leaves the guardian sticky alone', async () => {
    const { root, diff } = repo();
    const fake = new FakeGitHubClient({
      comments: [{ id: 1, body: `${STICKY_MARKER}\nguardian`, user: null }],
    });
    const res = await invokeGuardian(args(root, diff, ['--post-comment']), {
      env: CI_ENV,
      deps: {
        buildCommentClient: () => fake,
        mutationEngine: engine([{ line: 1, status: 'Survived' }]),
      },
    });
    expect(res.code).toBe(1);
    expect(fake.comments).toHaveLength(2);
    expect(fake.comments[0]!.body).toBe(`${STICKY_MARKER}\nguardian`);
    const mine = fake.comments[1]!.body;
    expect(mine.startsWith(MUTATION_MARKER)).toBe(true);
    expect(mine).toContain('### Mutation');
  });

  it('updates its sticky in place on the next run instead of stacking', async () => {
    const { root, diff } = repo();
    const fake = new FakeGitHubClient();
    const run = () =>
      invokeGuardian(args(root, diff, ['--post-comment']), {
        env: CI_ENV,
        deps: {
          buildCommentClient: () => fake,
          mutationEngine: engine([{ line: 1, status: 'Killed' }]),
        },
      });
    await run();
    await run();
    expect(fake.comments).toHaveLength(1);
  });

  it('posts an abstention too, so a stale survivor comment cannot linger', async () => {
    const { root, diff } = repo();
    const fake = new FakeGitHubClient();
    await invokeGuardian(args(root, diff, ['--post-comment']), {
      env: CI_ENV,
      deps: {
        buildCommentClient: () => fake,
        mutationEngine: engine([], {
          runStryker: () => ({ code: 1, timedOut: false, detail: 'boom' }),
        }),
      },
    });
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]!.body).toContain('Abstained');
  });

  it('posts a saved report without running anything (--post-report)', async () => {
    // The CI job runs the PR's tests WITHOUT a token, then posts from the
    // artifact in a separate step that has one.
    const { root, diff } = repo();
    const saved = join(root, 'mutation-report.json');
    await invokeGuardian(args(root, diff, ['--report-out', saved]), {
      deps: { mutationEngine: engine([{ line: 1, status: 'Survived' }]) },
    });
    const fake = new FakeGitHubClient();
    let counted = false;
    const res = await invokeGuardian(
      ['mutation', '--post-report', saved, '--post-comment'],
      {
        env: CI_ENV,
        deps: {
          buildCommentClient: () => fake,
          mutationEngine: engine([], {
            countMutants: () => {
              counted = true;
              return Promise.resolve([]);
            },
          }),
        },
      },
    );
    expect(counted).toBe(false);
    expect(res.code).toBe(1);
    expect(fake.comments[0]!.body).toContain('`ts/src/a.ts:1`');
  });

  // Killers for the dogfood run's survivors in the --post-report validator:
  // each case breaks exactly one field the renderer reads, so a validator
  // that stopped checking it would let that case through to a crash.
  describe('rejects a saved report with any field the renderer reads broken', () => {
    const FINDING = {
      path: 'ts/src/a.ts',
      line: 1,
      mutator: 'ConditionalExpression',
      replacement: 'false',
      status: 'survived',
      coveredBy: ['t'],
    };
    const VALID = {
      verdict: 'survivors',
      generated: 1,
      sampled: 1,
      untested: 0,
      killed: 0,
      survived: 1,
      noCoverage: 0,
      timeout: 0,
      findings: [FINDING],
      suppressed: [{ finding: FINDING, reason: 'why' }],
      excludedTests: [],
    };
    const broken: Array<[string, unknown]> = [
      ['a non-object', []],
      ['an unknown verdict', { ...VALID, verdict: 'passed' }],
      ['a non-string abstainReason', { ...VALID, abstainReason: 3 }],
      ['a missing count', { ...VALID, timeout: undefined }],
      ['a string count', { ...VALID, killed: '0' }],
      ['findings not an array', { ...VALID, findings: {} }],
      ['suppressed not an array', { ...VALID, suppressed: {} }],
      ['excludedTests not strings', { ...VALID, excludedTests: [1] }],
      ...(
        [
          'path',
          'line',
          'mutator',
          'replacement',
          'status',
          'coveredBy',
        ] as const
      ).map((k): [string, unknown] => [
        `a finding with a bad ${k}`,
        { ...VALID, findings: [FINDING, { ...FINDING, [k]: null }] },
      ]),
      [
        'a suppression without a reason',
        { ...VALID, suppressed: [{ finding: FINDING }] },
      ],
      [
        'a suppression with a bad finding',
        { ...VALID, suppressed: [{ finding: {}, reason: 'r' }] },
      ],
    ];

    it('accepts the valid report the cases are cut from', async () => {
      const { root } = repo();
      const saved = join(root, 'valid.json');
      writeFileSync(saved, JSON.stringify(VALID));
      const res = await invokeGuardian(['mutation', '--post-report', saved]);
      expect(res.code).toBe(1);
    });

    it.each(broken)('abstains on %s', async (_label, body) => {
      const { root } = repo();
      const saved = join(root, 'bad.json');
      writeFileSync(saved, JSON.stringify(body));
      const res = await invokeGuardian(['mutation', '--post-report', saved]);
      expect(res.code).toBe(3);
      expect(res.stdout).toContain('not a guardian mutation report');
    });
  });

  it('posts an abstention when the saved report cannot be read', async () => {
    const fake = new FakeGitHubClient();
    const res = await invokeGuardian(
      ['mutation', '--post-report', '/nonexistent/m.json', '--post-comment'],
      { env: CI_ENV, deps: { buildCommentClient: () => fake } },
    );
    expect(res.code).toBe(3);
    expect(fake.comments[0]!.body).toContain('could not be read');
  });

  it('keeps the comment under the size budget and points at the artifact', async () => {
    const { root, diff } = repo();
    const fake = new FakeGitHubClient();
    const many = Array.from({ length: 2000 }, () => ({
      line: 1,
      status: 'Survived',
    }));
    await invokeGuardian(args(root, diff, ['--post-comment']), {
      env: CI_ENV,
      deps: { buildCommentClient: () => fake, mutationEngine: engine(many) },
    });
    const body = fake.comments[0]!.body;
    expect(body.length).toBeLessThanOrEqual(COMMENT_CHAR_BUDGET);
    expect(body).toContain('mutation-report.json');
  });
});
