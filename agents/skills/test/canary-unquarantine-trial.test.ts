// canary-unquarantine trial + verdict (#1455): release through a trial run of
// the suite's own CI, never on ticket state.
//
// Git is real (a temp repo pushing to a temp bare origin) so the worktree,
// commit and push paths run for real; `gh` and `curl` are faked, so no
// network and no real pull request.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main } from '../claude-code/canary-unquarantine/scripts/cli.mjs';
import {
  applyEdits,
  embedManifest,
  planLift,
  readManifest,
} from '../claude-code/canary-unquarantine/scripts/lift.mjs';
import { selectRows } from '../claude-code/canary-unquarantine/scripts/trial.mjs';
import {
  downloadResults,
  judge,
  junitCases,
  playwrightCases,
  readCases,
} from '../claude-code/canary-unquarantine/scripts/results.mjs';
import { commentFailures } from '../claude-code/canary-unquarantine/scripts/settle.mjs';
import { spawnRunner } from '../claude-code/canary-unquarantine/scripts/exec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'unquarantine');
const TRACKER = JSON.parse(
  fs.readFileSync(path.join(FIXTURE, 'tracker.json'), 'utf8'),
);
const JIRA_ENV = {
  CANARY_JIRA_EMAIL: 'qa@example.com',
  CANARY_JIRA_API_TOKEN: 'not-a-real-token',
  // The only site credentials are sent to (#1456); other hosts abstain.
  CANARY_JIRA_BASE_URL: 'https://acme.atlassian.net',
};

const CARD =
  'FINDING: the warehouse list is unreachable, blocked by a missing permission';
const EVENT = 'FINDING: stock levels answer a proxy 502, not application data';
const V2 = 'a v2 row whose issue field outranks the comment';
const REF_FILE = 'tests/api/reference.spec.js';

type Result = {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string;
};

const tmps: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'unq-trial-'));
  tmps.push(d);
  return d;
};

beforeEach(() => {
  // Real git, isolated from the developer's own config (signing, hooks).
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_AUTHOR_NAME', 'Ada Lovelace');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'ada@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Ada Lovelace');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'ada@example.com');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** The fixture suite as a committed repo with a bare origin. */
function makeSuite() {
  const root = mkTmp();
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'suite');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  fs.cpSync(path.join(FIXTURE, 'suite'), repo, { recursive: true });
  fs.mkdirSync(path.join(repo, '.canary'));
  fs.copyFileSync(
    path.join(FIXTURE, 'quarantine.json'),
    path.join(repo, '.canary', 'quarantine.json'),
  );
  fs.copyFileSync(
    path.join(FIXTURE, 'company.json'),
    path.join(repo, '.canary', 'company.json'),
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'suite');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, origin };
}

/**
 * Real git; a fake gh/curl that answers the tracker from tracker.json and
 * plays the PR + CI side: `pr create` records the body, `pr view` returns it,
 * `run list` / `run download` serve a results file.
 */
function harness(opts: { results?: object; runStatus?: string } = {}) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const state: { body?: string; branch?: string; origin?: string } = {};
  const ok = (stdout: string): Result => ({
    status: 0,
    stdout,
    stderr: '',
    error: '',
  });
  const run = (
    cmd: string,
    args: string[],
    o: { input?: string; cwd?: string } = {},
  ): Result => {
    calls.push({ cmd, args, input: o.input });
    if (cmd === 'git') return spawnRunner(cmd, args, o);
    if (cmd === 'curl') {
      if (args.includes('POST')) return ok('{}');
      const key = /\/issue\/([^?/]+)/.exec(args[args.length - 1])?.[1] ?? '';
      const t = TRACKER.jira[decodeURIComponent(key)];
      if (!t) return { status: 22, stdout: '', stderr: 'HTTP 404', error: '' };
      return ok(
        JSON.stringify({
          fields: {
            summary: t.summary,
            status: { statusCategory: { key: t.statusCategory } },
            resolution: t.resolution ? { name: t.resolution } : null,
          },
        }),
      );
    }
    if (cmd !== 'gh')
      return { status: 127, stdout: '', stderr: 'not found', error: '' };
    if (args[0] === 'repo') return ok(TRACKER.github_repo);
    if (args[0] === 'api') {
      const target = args.find((a) => a.startsWith('repos/'))!;
      const m = /^repos\/(.+)\/issues\/(\d+)(\/comments)?$/.exec(target);
      const issue = m && TRACKER.github[m[1]]?.[m[2]];
      if (!issue)
        return { status: 1, stdout: '', stderr: 'HTTP 404', error: '' };
      if (m![3])
        return ok(
          issue.comments
            .map((body: string) => JSON.stringify({ body }))
            .join('\n'),
        );
      const { comments, ...rest } = issue;
      return ok(JSON.stringify(rest));
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      state.body = args[args.indexOf('--body') + 1];
      state.branch = args[args.indexOf('--head') + 1];
      state.origin = git(o.cwd!, 'remote', 'get-url', 'origin');
      return ok('https://github.com/acme/orders-suite/pull/77\n');
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const head = git(
        state.origin!,
        'rev-parse',
        `refs/heads/${state.branch}`,
      );
      return ok(
        JSON.stringify({
          body: state.body,
          headRefName: state.branch,
          headRefOid: head,
          url: 'https://github.com/acme/orders-suite/pull/77',
          state: 'OPEN',
        }),
      );
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const head = git(
        state.origin!,
        'rev-parse',
        `refs/heads/${state.branch}`,
      );
      return ok(
        JSON.stringify([
          {
            databaseId: 9,
            headSha: head,
            status: opts.runStatus ?? 'completed',
            conclusion: 'failure',
          },
        ]),
      );
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const dir = args[args.indexOf('-D') + 1];
      if (!opts.results)
        return {
          status: 1,
          stdout: '',
          stderr: 'no artifact matches',
          error: '',
        };
      fs.writeFileSync(
        path.join(dir, 'results.json'),
        JSON.stringify(opts.results),
      );
      return ok('');
    }
    if (args[0] === 'issue' && args[1] === 'comment')
      return ok(
        'https://github.com/acme/orders-suite/issues/505#issuecomment-1',
      );
    return {
      status: 1,
      stdout: '',
      stderr: `unexpected gh ${args.join(' ')}`,
      error: '',
    };
  };
  return { run, calls, state };
}

function callMain(argv: string[], deps: object) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void out.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void err.push(a.join(' ')),
  );
  const code = main(argv, deps);
  vi.mocked(console.log).mockRestore();
  vi.mocked(console.error).mockRestore();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** A Playwright JSON report for the reference file's three candidates. */
function report(outcomes: Record<string, string>) {
  const spec = (title: string, status: string) => ({
    title,
    file: REF_FILE,
    tests: [{ status, results: [] }],
  });
  return {
    suites: [
      {
        title: REF_FILE,
        file: REF_FILE,
        suites: [
          {
            title: 'GET /warehouses',
            file: REF_FILE,
            specs: [spec(CARD, outcomes.card)],
          },
          {
            title: 'GET /inventory/levels',
            file: REF_FILE,
            specs: [spec(EVENT, outcomes.event), spec(V2, outcomes.v2)],
          },
        ],
      },
    ],
  };
}

const branches = (origin: string) =>
  git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');

// --- trial ----------------------------------------------------------------------

describe('trial', () => {
  it('without --yes shows the plan and writes nothing anywhere', () => {
    const { repo, origin } = makeSuite();
    const h = harness();
    const r = callMain(['trial', '--repo', repo], {
      run: h.run,
      env: JIRA_ENV,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Trial plan: lift 3 quarantined test(s)');
    expect(r.stdout).toContain('Re-run with --yes');
    expect(branches(origin)).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(
      h.calls.some((c) => c.cmd === 'git' && c.args.includes('push')),
    ).toBe(false);
    expect(h.calls.some((c) => c.args[0] === 'pr')).toBe(false);
  });

  it('--include-abstained adds the rows whose tracker could not be read', () => {
    const { repo } = makeSuite();
    const r = callMain(
      ['trial', '--repo', repo, '--include-abstained', '--json'],
      { run: harness().run, env: JIRA_ENV },
    );
    const plan = JSON.parse(r.stdout);
    expect(plan.lifts.map((l: any) => l.class).sort()).toEqual([
      'abstain',
      'abstain',
      'abstain',
      'candidate',
      'candidate',
      'candidate',
    ]);
    expect(plan.confirmed).toBe(false);
  });

  it('--yes opens one draft PR from a worktree, leaving the checkout untouched', () => {
    const { repo, origin } = makeSuite();
    const h = harness();
    const before = git(repo, 'rev-parse', 'HEAD');
    const r = callMain(
      ['trial', '--repo', repo, '--yes', '--branch', 'canary/trial'],
      { run: h.run, env: JIRA_ENV },
    );
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      'Opened trial PR https://github.com/acme/orders-suite/pull/77 lifting 3 test(s)',
    );

    // The user's checkout: same branch, same commit, clean, no worktree left behind.
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);

    // The trial branch lifts exactly the candidates' markers.
    const lifted = git(origin, 'show', `canary/trial:${REF_FILE}`);
    expect(lifted).toContain(`test('${CARD}'`);
    expect(lifted).toContain(`test('${EVENT}'`);
    expect(lifted).toContain(`test('${V2}'`);
    expect(lifted).toContain("test.skip('a row whose ticket cannot be read'");
    expect(git(origin, 'diff', '--stat', 'main', 'canary/trial')).toMatch(
      /1 file changed/,
    );

    const create = h.calls.find(
      (c) => c.args[0] === 'pr' && c.args[1] === 'create',
    )!;
    expect(create.args).toContain('--draft');
    const manifest = readManifest(h.state.body!);
    expect(manifest.base).toBe(before);
    expect(manifest.ledger).toBe('.canary/quarantine.json');
    expect(manifest.lifts.map((l: any) => l.test).sort()).toEqual(
      [CARD, EVENT, V2].sort(),
    );
  });

  it('abstains (exit 3 under --strict) when there is nothing to trial', () => {
    const dir = mkTmp();
    const r = callMain(['trial', '--repo', dir, '--strict'], {
      run: harness().run,
      env: {},
    });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('nothing to trial: zero ledger rows read');
  });

  it('refuses a ledger outside the repository', () => {
    const { repo } = makeSuite();
    const r = callMain(
      [
        'trial',
        '--repo',
        repo,
        '--yes',
        '--ledger',
        path.join(FIXTURE, 'quarantine.json'),
      ],
      {
        run: harness().run,
        env: JIRA_ENV,
      },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/trial needs the ledger inside the repository/);
  });
});

// --- verdict --------------------------------------------------------------------

describe('verdict', () => {
  function opened(results?: object, runStatus?: string) {
    const suite = makeSuite();
    const h = harness({ results, runStatus });
    const r = callMain(
      ['trial', '--repo', suite.repo, '--yes', '--branch', 'canary/trial'],
      { run: h.run, env: JIRA_ENV },
    );
    expect(r.code).toBe(0);
    return { ...suite, h };
  }

  it('reads each lifted test from the run, and without --apply writes nothing', () => {
    const { repo, origin, h } = opened();
    const results = path.join(mkTmp(), 'results.json');
    fs.writeFileSync(
      results,
      JSON.stringify(
        report({ card: 'unexpected', event: 'expected', v2: 'flaky' }),
      ),
    );
    const head = git(origin, 'rev-parse', 'canary/trial');
    const r = callMain(
      ['verdict', '--repo', repo, '--pr', '77', '--results', results, '--json'],
      { run: h.run, env: JIRA_ENV },
    );
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(
      Object.fromEntries(doc.tests.map((t: any) => [t.test, t.outcome])),
    ).toEqual({ [CARD]: 'fail', [EVENT]: 'pass', [V2]: 'flaky' });
    expect(doc.flake_hunter).toEqual([{ test: V2, file: REF_FILE }]);
    expect(doc.applied).toBe(false);
    expect(git(origin, 'rev-parse', 'canary/trial')).toBe(head);
    expect(h.calls.some((c) => c.args[0] === 'issue')).toBe(false);
  });

  it('--apply releases the pass, re-quarantines the fail and the flake, and tells the ticket', () => {
    const { repo, origin, h } = opened(
      report({ card: 'unexpected', event: 'expected', v2: 'flaky' }),
    );
    const r = callMain(
      [
        'verdict',
        '--repo',
        repo,
        '--pr',
        '77',
        '--artifact',
        'playwright-json',
        '--apply',
        '--strict',
      ],
      {
        run: h.run,
        env: JIRA_ENV,
      },
    );
    expect(r.stderr).toBe('');
    expect(r.code).toBe(1); // a fail and a flake need a person
    expect(r.stdout).toContain('Hand to canary-flake-hunter');

    // Files: base + only the passing lift. The fail and the flake are back byte for byte.
    const base = git(origin, 'show', `main:${REF_FILE}`).split('\n');
    const after = git(origin, 'show', `canary/trial:${REF_FILE}`).split('\n');
    const diff = after.filter((l, i) => l !== base[i]);
    expect(after).toContain(`  test('${EVENT}', async ({`);
    expect(after).toContain(`  test.skip('${CARD}', async ({`);
    expect(after).toContain(`  test.skip('${V2}', async () => {});`);
    expect(diff.length).toBeGreaterThan(0);
    expect(after.filter((l) => l.includes('test.skip(')).length).toBe(
      base.filter((l) => l.includes('test.skip(')).length - 1,
    );

    // Ledger: the passing row is gone; the failing row now names its blocker.
    const ledger = JSON.parse(
      git(origin, 'show', 'canary/trial:.canary/quarantine.json'),
    );
    const tests = ledger.entries.map((e: any) => e.test);
    expect(tests).not.toContain(EVENT);
    expect(tests).toContain(CARD);
    expect(ledger.entries.find((e: any) => e.test === CARD).issue).toBe(
      'https://github.com/acme/orders-suite/issues/505',
    );
    expect(ledger.entries).toHaveLength(15);

    // The failing ticket is told, on GitHub.
    const comment = h.calls.find(
      (c) => c.args[0] === 'issue' && c.args[1] === 'comment',
    )!;
    expect(comment.args.slice(0, 3)).toEqual(['issue', 'comment', '505']);
    expect(comment.args).toContain('-R');
    expect(comment.args[comment.args.indexOf('--body') + 1]).toMatch(
      /still fails/,
    );

    // And the user's own checkout never moved.
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('a lifted test that never appeared in the run is not a pass', () => {
    const { repo, h } = opened(
      report({ card: 'expected', event: 'expected', v2: 'expected' }),
    );
    const results = path.join(mkTmp(), 'r.json');
    const partial = report({
      card: 'expected',
      event: 'expected',
      v2: 'expected',
    });
    (partial.suites[0].suites[1] as any).specs = (
      partial.suites[0].suites[1] as any
    ).specs.slice(0, 1);
    fs.writeFileSync(results, JSON.stringify(partial));
    const r = callMain(
      [
        'verdict',
        '--repo',
        repo,
        '--pr',
        '77',
        '--results',
        results,
        '--json',
        '--strict',
      ],
      { run: h.run, env: JIRA_ENV },
    );
    const doc = JSON.parse(r.stdout);
    expect(doc.tests.find((t: any) => t.test === V2).outcome).toBe('missing');
    expect(doc.abstained).toBe(true);
    expect(r.code).toBe(3);
  });

  it('abstains when CI on the trial commit has not finished', () => {
    const { repo, h } = opened(
      report({ card: 'expected', event: 'expected', v2: 'expected' }),
      'in_progress',
    );
    const r = callMain(
      ['verdict', '--repo', repo, '--pr', '77', '--artifact', 'x', '--strict'],
      { run: h.run, env: JIRA_ENV },
    );
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/has not finished/);
  });

  it('abstains when the run uploaded no such artifact', () => {
    const { repo, h } = opened(undefined);
    const r = callMain(
      [
        'verdict',
        '--repo',
        repo,
        '--pr',
        '77',
        '--artifact',
        'nope',
        '--strict',
      ],
      { run: h.run, env: JIRA_ENV },
    );
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/no artifact "nope"/);
  });

  it('abstains with no results source rather than reading the run conclusion', () => {
    const { repo, h } = opened();
    const r = callMain(['verdict', '--repo', repo, '--pr', '77', '--strict'], {
      run: h.run,
      env: JIRA_ENV,
    });
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(
      /the run conclusion alone cannot say which test passed/,
    );
  });

  it('abstains on a results file with no test cases in it', () => {
    const { repo, h } = opened();
    const results = path.join(mkTmp(), 'empty.json');
    fs.writeFileSync(results, JSON.stringify({ suites: [] }));
    const r = callMain(
      [
        'verdict',
        '--repo',
        repo,
        '--pr',
        '77',
        '--results',
        results,
        '--strict',
      ],
      { run: h.run, env: JIRA_ENV },
    );
    expect(r.code).toBe(3);
  });

  it('needs --pr', () => {
    const r = callMain(['verdict'], { run: harness().run });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/verdict needs --pr N/);
  });

  it('refuses a PR that no trial opened', () => {
    const run = () => ({
      status: 0,
      stdout: JSON.stringify({
        body: 'hello',
        headRefName: 'x',
        headRefOid: 'y',
      }),
      stderr: '',
      error: '',
    });
    const r = callMain(['verdict', '--pr', '5', '--results', '.'], { run });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/carries no canary-unquarantine-trial manifest/);
  });
});

describe('commentFailures', () => {
  const fail = (blockers: object[]) => ({
    test: 't',
    file: 'f',
    outcome: 'fail',
    cases: 1,
    blockers,
  });

  it('comments on Jira through the commenter, and lists it for a person when it cannot', () => {
    const jira = {
      id: 'CORE-1',
      tracker: 'jira',
      key: 'CORE-1',
      project: 'CORE',
    };
    const told = commentFailures({
      run: () => ({ status: 0 }),
      repo: '.',
      judged: [fail([jira])],
      prUrl: 'u',
      jiraComment: () => ({ ok: true, why: '' }),
    });
    expect(told[0]).toMatchObject({ commented: true, target: 'CORE-1' });
    const notTold = commentFailures({
      run: () => ({ status: 0 }),
      repo: '.',
      judged: [fail([jira])],
      prUrl: 'u',
    });
    expect(notTold[0]).toMatchObject({
      commented: false,
      why: 'Jira is not configured; comment by hand',
    });
    expect(notTold[0].body).toMatch(/still fails/);
  });

  it('a failing row with no blocker says so', () => {
    expect(
      commentFailures({
        run: () => ({ status: 0 }),
        repo: '.',
        judged: [fail([])],
        prUrl: 'u',
      })[0].why,
    ).toBe('no blocker to comment on');
  });

  it('reports a gh comment that failed', () => {
    const notes = commentFailures({
      run: () => ({ status: 1, stderr: 'HTTP 403' }),
      repo: '.',
      judged: [fail([{ id: 'a/b#3', tracker: 'github' }])],
      prUrl: 'u',
    });
    expect(notes[0]).toMatchObject({ commented: false, why: 'HTTP 403' });
  });
});

// --- lifting markers ------------------------------------------------------------

describe('planLift', () => {
  const lift = (src: string, markerLine: number, extra: object = {}) => {
    const lines = src.split('\n');
    const plan = planLift(
      lines,
      { markerLine, marker: 'test.skip', test: 't', ...extra },
      ['@known-failure'],
    );
    return 'why' in plan ? plan : applyEdits(lines, plan.edits).join('\n');
  };

  it.each([
    ["test.skip('t', () => {});", "test('t', () => {});"],
    ["test.describe.skip('t', () => {", "test.describe('t', () => {"],
    ["describe.skip('t', () => {", "describe('t', () => {"],
    ["it.skip('t', () => {});", "it('t', () => {});"],
    ["test.fixme('t', () => {});", "test('t', () => {});"],
    ["xit('t', () => {});", "it('t', () => {});"],
    ["xdescribe('t', () => {", "describe('t', () => {"],
    ["test('t @known-failure', () => {});", "test('t', () => {});"],
  ])('%s -> %s', (before, after) => {
    expect(lift(before, 1)).toBe(after);
  });

  it('drops the eslint directive that only permitted the skip', () => {
    const src =
      "// keep me\n// eslint-disable-next-line no-skipped-tests\ntest.skip('t', () => {});";
    expect(lift(src, 3)).toBe("// keep me\ntest('t', () => {});");
  });

  it('removes every pytest skip decorator stacked on the test, keeping others', () => {
    const src =
      '@pytest.mark.skip(reason="x")\n@pytest.mark.slow\n@pytest.mark.xfail\ndef test_a():\n    pass';
    expect(lift(src, 1)).toBe('@pytest.mark.slow\ndef test_a():\n    pass');
  });

  it('refuses a runtime guard', () => {
    expect(
      lift("test('t', () => {\n  guard();\n});", 2, { runtime: true }),
    ).toMatchObject({ why: expect.stringMatching(/runtime guard/) });
  });

  it('refuses a line that no longer carries the marker', () => {
    expect(lift("test('t', () => {});", 1)).toMatchObject({
      why: expect.stringMatching(/no longer carries/),
    });
  });

  it('refuses a line past the end of the file', () => {
    expect(lift("test.skip('t')", 9)).toMatchObject({
      why: expect.stringMatching(/past the end/),
    });
  });

  it('applyEdits refuses an edit whose line changed since the plan', () => {
    expect(() =>
      applyEdits(['a'], [{ line: 1, before: 'b', after: 'c' }]),
    ).toThrow(/changed since the plan/);
  });
});

describe('selectRows and the manifest', () => {
  it('lifts one marker once however many duplicate rows name it', () => {
    const row = (index: number, cls: string) => ({
      index,
      class: cls,
      file: 'a.spec.js',
      markerLine: 3,
      test: 't',
      kind: 'skipped',
      marker: 'test.skip',
    });
    const picked = selectRows({
      rows: [
        row(0, 'candidate'),
        row(1, 'candidate'),
        { ...row(2, 'blocked'), markerLine: 9 },
      ],
    });
    expect(picked).toHaveLength(1);
    expect(picked[0].ledgerRows.map((r: any) => r.index)).toEqual([0, 1]);
  });

  it('round-trips through a PR body, including a title with "--" in it', () => {
    const manifest = {
      schema_version: 1,
      lifts: [{ test: 'BULK bulk orders -- approval-gated' }],
    };
    const body = `text\n\n${embedManifest(manifest)}\n`;
    expect(
      body.slice(body.indexOf('<!--') + 4, body.lastIndexOf('-->')),
    ).not.toContain('--');
    expect(readManifest(body)).toEqual(manifest);
    expect(readManifest('no manifest here')).toBeNull();
  });
});

// --- reading results ------------------------------------------------------------

describe('results', () => {
  it('flattens a Playwright report with describe nesting', () => {
    const cases = playwrightCases(
      report({ card: 'expected', event: 'unexpected', v2: 'skipped' }),
    );
    expect(cases.map((c) => [c.titlePath.join(' > '), c.outcome])).toEqual([
      [`GET /warehouses > ${CARD}`, 'pass'],
      [`GET /inventory/levels > ${EVENT}`, 'fail'],
      [`GET /inventory/levels > ${V2}`, 'skipped'],
    ]);
  });

  it('a lifted describe is judged on every case under it', () => {
    const cases = playwrightCases(
      report({ card: 'expected', event: 'expected', v2: 'unexpected' }),
    );
    expect(
      judge({ test: 'GET /inventory/levels', file: REF_FILE }, cases),
    ).toEqual({ outcome: 'fail', cases: 2 });
    expect(judge({ test: 'GET /warehouses', file: REF_FILE }, cases)).toEqual({
      outcome: 'pass',
      cases: 1,
    });
  });

  it('reads JUnit XML (pytest --junitxml)', () => {
    const xml =
      '<testsuite><testcase classname="tests.py.test_orders" name="test_refund_reverses_points" file="tests/py/test_orders.py">' +
      '<failure message="x"/></testcase><testcase classname="tests.py.test_orders" name="test_order_total"/>' +
      '<testcase classname="tests.py.test_orders" name="test_s"><skipped/></testcase></testsuite>';
    const cases = junitCases(xml);
    expect(cases.map((c) => c.outcome)).toEqual(['fail', 'pass', 'skipped']);
    expect(
      judge(
        {
          test: 'test_refund_reverses_points',
          file: 'tests/py/test_orders.py',
        },
        cases,
      ).outcome,
    ).toBe('fail');
  });

  it('reads every result document in a directory and ignores other JSON', () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, 'a.json'),
      JSON.stringify(
        report({ card: 'expected', event: 'expected', v2: 'expected' }),
      ),
    );
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    const { cases, read } = readCases(dir);
    expect(cases).toHaveLength(3);
    expect(read.map((f) => path.basename(f))).toEqual(['a.json']);
  });

  it('a run list that is not JSON abstains with the reason instead of throwing', () => {
    const run = () => ({ status: 0, stdout: '<html>', stderr: '', error: '' });
    const out = downloadResults(run, {
      repo: '.',
      headRefName: 'canary/trial',
      headRefOid: 'a'.repeat(40),
      artifact: 'playwright-json',
    });
    expect(out).toEqual({
      why: expect.stringMatching(/gh run list returned unparseable JSON/),
    });
  });
});

// --- the PR body is untrusted: settle stays inside the trial worktree ---------

describe('verdict --apply refuses a manifest that reaches outside the worktree', () => {
  /** Open a trial, then rewrite its PR-body manifest the way an editor of the PR could. */
  function tampered(change: (m: any) => void) {
    const results = report({
      card: 'expected',
      event: 'expected',
      v2: 'expected',
    });
    const suite = makeSuite();
    const h = harness({ results });
    expect(
      callMain(
        ['trial', '--repo', suite.repo, '--yes', '--branch', 'canary/trial'],
        { run: h.run, env: JIRA_ENV },
      ).code,
    ).toBe(0);
    const manifest = readManifest(h.state.body!);
    change(manifest);
    h.state.body = `edited\n\n${embedManifest(manifest)}\n`;
    const head = git(suite.origin, 'rev-parse', 'canary/trial');
    const r = callMain(
      [
        'verdict',
        '--repo',
        suite.repo,
        '--pr',
        '77',
        '--artifact',
        'playwright-json',
        '--apply',
      ],
      { run: h.run, env: JIRA_ENV },
    );
    return { ...suite, h, r, head };
  }

  /** Refused: non-zero, named, nothing pushed, no ticket told. */
  function expectRefused(
    t: ReturnType<typeof tampered>,
    why = /escapes the trial worktree/,
  ) {
    expect(t.r.code).not.toBe(0);
    expect(t.r.stderr).toMatch(why);
    expect(git(t.origin, 'rev-parse', 'canary/trial')).toBe(t.head);
    expect(t.h.calls.some((c) => c.args[0] === 'issue')).toBe(false);
  }

  /** A file outside every worktree, holding `text`. */
  function victim(name: string, text: string) {
    const dir = mkTmp();
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return { dir, file };
  }

  it('a lifted file with ../ is refused', () => {
    expectRefused(
      tampered((m) => {
        m.lifts[0].file = `../../../${m.lifts[0].file}`;
      }),
    );
  });

  it('an absolute lifted file is refused, and the file there is untouched', () => {
    const v = victim('x.spec.js', 'outside\n');
    expectRefused(
      tampered((m) => {
        m.lifts[0].file = v.file;
      }),
    );
    expect(fs.readFileSync(v.file, 'utf8')).toBe('outside\n');
  });

  it('a ledger path with ../ is refused', () => {
    expectRefused(
      tampered((m) => {
        m.ledger = '../../outside/quarantine.json';
      }),
    );
  });

  it('an absolute ledger path is refused', () => {
    const v = victim('quarantine.json', '{"schema_version":1,"entries":[]}\n');
    expectRefused(
      tampered((m) => {
        m.ledger = v.file;
      }),
    );
    expect(fs.readFileSync(v.file, 'utf8')).toBe(
      '{"schema_version":1,"entries":[]}\n',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'a ledger reached through a committed symlink out of the repo is refused, and not written',
    () => {
      const v = victim(
        'quarantine.json',
        '{"schema_version":1,"entries":[]}\n',
      );
      const t = tampered((m) => {
        m.ledger = 'escape/quarantine.json';
      });
      // tampered() ran with the link absent; commit it and run again.
      fs.symlinkSync(v.dir, path.join(t.repo, 'escape'));
      git(t.repo, 'add', 'escape');
      git(t.repo, 'commit', '-q', '-m', 'link');
      git(t.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/canary/trial', '-f');
      const head = git(t.origin, 'rev-parse', 'canary/trial');
      const r = callMain(
        [
          'verdict',
          '--repo',
          t.repo,
          '--pr',
          '77',
          '--artifact',
          'playwright-json',
          '--apply',
        ],
        { run: t.h.run, env: JIRA_ENV },
      );
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/escapes the trial worktree/);
      expect(git(t.origin, 'rev-parse', 'canary/trial')).toBe(head);
      expect(fs.readFileSync(v.file, 'utf8')).toBe(
        '{"schema_version":1,"entries":[]}\n',
      );
    },
  );

  it('a manifest base that is not a commit id is refused (it is passed to git show)', () => {
    expectRefused(
      tampered((m) => {
        m.base = '--output=/tmp/x';
      }),
      /not a commit id/,
    );
  });
});
