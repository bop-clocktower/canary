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
import { commentFailures } from '../claude-code/canary-unquarantine/scripts/notify.mjs';
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
  const state: {
    body?: string;
    branch?: string;
    origin?: string;
    isCrossRepository?: boolean | null;
    defaultBranch?: string;
    repoName?: string;
    headRefName?: string;
  } = { defaultBranch: 'main', repoName: TRACKER.github_repo };
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
    if (args[0] === 'repo') {
      const name = args.includes('defaultBranchRef')
        ? state.defaultBranch
        : state.repoName;
      return name
        ? ok(name)
        : { status: 1, stdout: '', stderr: 'HTTP 404', error: '' };
    }
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
      const pr: Record<string, unknown> = {
        body: state.body,
        headRefName: state.headRefName ?? state.branch,
        headRefOid: head,
        url: 'https://github.com/acme/orders-suite/pull/77',
        state: 'OPEN',
        isCrossRepository:
          state.isCrossRepository === undefined
            ? false
            : state.isCrossRepository,
      };
      // Like the real gh, only the fields asked for: a field the code forgot
      // to request reads as absent here too.
      const asked = args[args.indexOf('--json') + 1].split(',');
      return ok(
        JSON.stringify(Object.fromEntries(asked.map((f) => [f, pr[f]]))),
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

  it('--apply lists a handed-off Jira blocker for a person, and leaves its row alone', () => {
    // EVENT's blocker is #506, whose comment files it as CORE-101 (Jira). The
    // ledger and the test source name only #506, so at verdict time nothing
    // trusted vouches for CORE-101: no comment, no re-point, a note to post.
    const { repo, origin, h } = opened(
      report({ card: 'expected', event: 'unexpected', v2: 'expected' }),
    );
    const manifest = readManifest(h.state.body!);
    const lift = manifest.lifts.find((l: any) => l.test === EVENT);
    expect(lift.blockers.at(-1)).toMatchObject({
      id: 'CORE-101',
      tracker: 'jira',
      key: 'CORE-101',
      via: ['acme/orders-suite#506', 'CORE-101'],
    });

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
        '--json',
      ],
      { run: h.run, env: JIRA_ENV },
    );
    expect(r.stderr).toBe('');
    expect(
      h.calls.some((c) => c.cmd === 'curl' && c.args.includes('POST')),
    ).toBe(false);
    const note = JSON.parse(r.stdout).comments[0];
    expect(note).toMatchObject({ commented: false, target: 'CORE-101' });
    expect(note.why).toMatch(/hand-off/);
    expect(note.body).toMatch(/still fails/);
    expect(note.body).not.toMatch(/against this ticket/);
    const ledger = JSON.parse(
      git(origin, 'show', 'canary/trial:.canary/quarantine.json'),
    );
    expect(ledger.entries.find((e: any) => e.test === EVENT).issue ?? '').toBe(
      '',
    );
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
        isCrossRepository: false,
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
    trustedTarget: blockers.at(-1),
  });

  it('comments on nothing the trusted check did not resolve, whatever the blocker says', () => {
    const calls: unknown[] = [];
    const [note] = commentFailures({
      run: (...a: unknown[]) => {
        calls.push(a);
        return { status: 0 };
      },
      repo: '.',
      judged: [
        {
          ...fail([{ id: 'a/b#3', tracker: 'github' }]),
          trustedTarget: undefined,
        },
      ],
      prUrl: 'u',
      jiraComment: (ref: unknown) => {
        calls.push(ref);
        return { ok: true, why: '' };
      },
    });
    expect(calls).toEqual([]);
    expect(note).toMatchObject({ commented: false, target: 'a/b#3' });
    expect(note.body).toMatch(/still fails/);
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

  it('takes a Jira project from the key, never from an edited manifest', () => {
    // The manifest lives in the PR body, so anyone who can edit the PR can
    // pair an allowed project with another project's key. The per-project
    // gate must see the key's own project.
    const seen: any[] = [];
    commentFailures({
      run: () => ({ status: 0 }),
      repo: '.',
      judged: [
        fail([
          { id: 'OTHER-9', tracker: 'jira', key: 'OTHER-9', project: 'CORE' },
        ]),
      ],
      prUrl: 'u',
      jiraComment: (ref) => {
        seen.push(ref);
        return { ok: true, why: '' };
      },
    });
    expect(seen[0]).toMatchObject({ key: 'OTHER-9', project: 'OTHER' });
  });

  describe('the note holds the title and file as plain, bounded text', () => {
    const noteFor = (test: string, file = 'f') =>
      commentFailures({
        run: () => ({ status: 1, stderr: 'no' }),
        repo: '.',
        judged: [
          {
            ...fail([{ id: 'CORE-1', tracker: 'jira', key: 'CORE-1' }]),
            test,
            file,
          },
        ],
        prUrl: 'u',
      })[0].body as string;

    it('caps a long title and a long file path', () => {
      const body = noteFor('T'.repeat(70000), `${'d/'.repeat(30000)}x.spec.js`);
      expect(body.length).toBeLessThan(1000);
      expect(body).toContain(`\`${'T'.repeat(200)}…\``);
    });

    it('keeps a title that fits exactly as it is', () => {
      expect(noteFor('adds an item (#12)')).toContain('`adds an item (#12)`');
      expect(noteFor('T'.repeat(200))).toContain(`\`${'T'.repeat(200)}\``);
    });

    it('cannot leave the code span or start a new line', () => {
      // Line separator, right-to-left override, zero-width space.
      const [ls, rlo, zwsp] = [0x2028, 0x202e, 0x200b].map((c) =>
        String.fromCodePoint(c),
      );
      const body = noteFor(`a\` b\r\nc${ls}d${rlo}e${zwsp}f`, 'g`h\ni');
      expect(body).toContain("`a' b c def` (`g'h i`)");
      for (const banned of ['\r', '\n', ls, rlo, zwsp])
        expect(body).not.toContain(banned);
    });
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
      '<testsuite><testcase classname="tests.py.test_orders" name="test_refund_restocks_items" file="tests/py/test_orders.py">' +
      '<failure message="x"/></testcase><testcase classname="tests.py.test_orders" name="test_order_total"/>' +
      '<testcase classname="tests.py.test_orders" name="test_s"><skipped/></testcase></testsuite>';
    const cases = junitCases(xml);
    expect(cases.map((c) => c.outcome)).toEqual(['fail', 'pass', 'skipped']);
    expect(
      judge(
        {
          test: 'test_refund_restocks_items',
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

/**
 * Commit `edit` on the trial branch only: from a detached checkout of the
 * pushed branch, with the operator's own main put back afterwards.
 */
function onTrialBranch(repo: string, edit: () => void) {
  git(repo, 'fetch', '-q', 'origin', 'refs/heads/canary/trial');
  git(repo, 'checkout', '-q', 'FETCH_HEAD');
  edit();
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'on the trial branch');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/canary/trial');
  git(repo, 'checkout', '-q', 'main');
}

describe('verdict --apply acts only on what the default branch vouches for', () => {
  type Outcomes = Parameters<typeof report>[0];
  type Suite = ReturnType<typeof makeSuite>;
  const ALL_PASS = { card: 'expected', event: 'expected', v2: 'expected' };
  const CARD_FAILS = { ...ALL_PASS, card: 'unexpected' };
  const EVENT_FAILS = { ...ALL_PASS, event: 'unexpected' };
  const LEDGER = '.canary/quarantine.json';
  const THIS_REPO = 'acme/orders-suite';

  /** Commit a ledger change on main and push it: what the default branch says. */
  function onMain(repo: string, edit: (entries: any[]) => any[]) {
    const file = path.join(repo, LEDGER);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.entries = edit(doc.entries);
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'ledger');
    git(repo, 'push', '-q', 'origin', 'main');
  }
  const rowNamed =
    (test: string, issue: string) =>
    (entries: any[]): any[] =>
      entries.map((e) => (e.test === test ? { ...e, issue } : e));

  /** Open a trial, let `change` edit its manifest as an editor could, apply. */
  function settle(
    outcomes: Outcomes,
    {
      change = () => {},
      before = () => {},
      after = () => {},
    }: {
      change?: (m: any) => void;
      before?: (s: Suite) => void;
      after?: (s: Suite, h: ReturnType<typeof harness>) => void;
    } = {},
  ) {
    const suite = makeSuite();
    before(suite);
    const h = harness({ results: report(outcomes) });
    expect(
      callMain(
        ['trial', '--repo', suite.repo, '--yes', '--branch', 'canary/trial'],
        { run: h.run, env: JIRA_ENV },
      ).code,
    ).toBe(0);
    const manifest = readManifest(h.state.body!);
    change(manifest);
    h.state.body = `edited\n\n${embedManifest(manifest)}\n`;
    after(suite, h);
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
        '--json',
      ],
      { run: h.run, env: JIRA_ENV },
    );
    const told = {
      github: h.calls.filter((c) => c.args[0] === 'issue'),
      jira: h.calls.filter((c) => c.cmd === 'curl' && c.args.includes('POST')),
    };
    return { ...suite, h, r, head, told };
  }
  type Settled = ReturnType<typeof settle>;

  const leafOf = (m: any, test: string) =>
    m.lifts.find((l: any) => l.test === test).blockers.at(-1);
  const liftOf = (m: any, test: string) =>
    m.lifts.find((l: any) => l.test === test);
  const trialLedger = (t: Settled) =>
    JSON.parse(git(t.origin, 'show', `canary/trial:${LEDGER}`)).entries;
  const rowOf = (t: Settled, test: string) =>
    trialLedger(t).find((e: any) => e.test === test);

  function expectRefused(t: Settled, why: RegExp) {
    expect(t.r.code).not.toBe(0);
    expect(t.r.stderr).toMatch(why);
    expect(git(t.origin, 'rev-parse', 'canary/trial')).toBe(t.head);
    expect(t.told.github).toEqual([]);
    expect(t.told.jira).toEqual([]);
  }

  /** Settled, but the note went to a person and the ticket heard nothing. */
  function expectListed(t: Settled, target: string) {
    expect(t.r.stderr).toBe('');
    expect(t.r.code).toBe(0);
    expect(t.told.github).toEqual([]);
    expect(t.told.jira).toEqual([]);
    const [note] = JSON.parse(t.r.stdout).comments;
    expect(note).toMatchObject({ commented: false, target });
    expect(note.why).toMatch(/hand-off/);
    expect(git(t.origin, 'rev-parse', 'canary/trial')).not.toBe(t.head);
  }

  describe('a blocker the trusted row names is told', () => {
    it('on GitHub, from the trusted ref, whatever URL the manifest carries', () => {
      const t = settle(CARD_FAILS, {
        change: (m) => {
          leafOf(m, CARD).url = 'https://example.com/elsewhere';
        },
      });
      expect(t.r.stderr).toBe('');
      expect(t.told.github).toHaveLength(1);
      expect(t.told.github[0].args.slice(0, 3)).toEqual([
        'issue',
        'comment',
        '505',
      ]);
      expect(t.told.github[0].args).toContain(THIS_REPO);
      expect(rowOf(t, CARD).issue).toBe(
        `https://github.com/${THIS_REPO}/issues/505`,
      );
    });

    it('on GitHub when the manifest spells the id bare or in another case', () => {
      for (const id of ['#505', 'ACME/orders-suite#505']) {
        const t = settle(CARD_FAILS, {
          change: (m) => {
            leafOf(m, CARD).id = id;
          },
        });
        expect(t.r.stderr).toBe('');
        expect(t.told.github[0].args).toContain(THIS_REPO);
      }
    });

    it('on Jira, when the row itself names the key', () => {
      const url = 'https://acme.atlassian.net/browse/CORE-101';
      const t = settle(EVENT_FAILS, {
        before: (s) => onMain(s.repo, rowNamed(EVENT, url)),
        change: (m) => {
          leafOf(m, EVENT).url = 'https://example.com/elsewhere';
        },
      });
      expect(t.r.stderr).toBe('');
      expect(t.told.jira).toHaveLength(1);
      expect(t.told.jira[0].args.at(-1)).toBe(
        'https://acme.atlassian.net/rest/api/2/issue/CORE-101/comment',
      );
      expect(rowOf(t, EVENT).issue).toBe(url);
    });
  });

  describe('a blocker it does not name, claiming no hand-off, refuses the whole settle', () => {
    it.each([
      ['no chain', undefined],
      ['a one-entry chain', ['someone/else#9']],
      ['a chain not ending at the blocker', [`${THIS_REPO}#505`, '#1']],
      ['a chain not starting at a named ticket', ['#1', 'someone/else#9']],
      ['a chain that is not a list', 'someone/else#9'],
    ])('GitHub, %s', (_n, via) => {
      const t = settle(CARD_FAILS, {
        change: (m) => {
          Object.assign(leafOf(m, CARD), { id: 'someone/else#9', via });
        },
      });
      expectRefused(t, /not named by its ledger row/);
    });

    it('Jira, naming another ticket in an allowed project', () => {
      const t = settle(EVENT_FAILS, {
        before: (s) => onMain(s.repo, rowNamed(EVENT, 'CORE-101')),
        change: (m) => {
          Object.assign(leafOf(m, EVENT), {
            id: 'CORE-999',
            key: 'CORE-999',
            via: ['CORE-999'],
          });
        },
      });
      expectRefused(t, /not named by its ledger row/);
    });

    it('even when only the passing lifts would otherwise settle', () => {
      const t = settle(CARD_FAILS, {
        change: (m) => {
          Object.assign(leafOf(m, CARD), { id: 'someone/else#9', via: [] });
        },
      });
      expect(rowOf(t, EVENT)).toBeDefined();
      expectRefused(t, /not named by its ledger row/);
    });
  });

  describe('a claimed hand-off is listed for a person, forged or not', () => {
    it('GitHub: the chain starts at a named ticket, and the target hears nothing', () => {
      const t = settle(CARD_FAILS, {
        change: (m) => {
          Object.assign(leafOf(m, CARD), {
            id: 'someone/else#9',
            url: 'https://example.com/elsewhere',
            via: [`${THIS_REPO}#505`, 'someone/else#9'],
          });
        },
      });
      expectListed(t, 'someone/else#9');
      expect(rowOf(t, CARD).issue ?? '').toBe('');
    });

    it('Jira: the same, with another ticket in an allowed project', () => {
      const t = settle(EVENT_FAILS, {
        change: (m) => {
          Object.assign(leafOf(m, EVENT), {
            id: 'CORE-999',
            key: 'CORE-999',
            via: [`${THIS_REPO}#506`, 'CORE-999'],
          });
        },
      });
      expectListed(t, 'CORE-999');
      expect(rowOf(t, EVENT).issue ?? '').toBe('');
    });

    it('a manifest cannot declare its own verified target', () => {
      const t = settle(CARD_FAILS, {
        change: (m) => {
          const forged = { id: 'someone/else#9', tracker: 'github' };
          Object.assign(leafOf(m, CARD), {
            ...forged,
            via: [`${THIS_REPO}#505`, forged.id],
          });
          liftOf(m, CARD).trustedTarget = forged;
        },
      });
      expectListed(t, 'someone/else#9');
    });

    it('the listed target is shown as plain, bounded text', () => {
      const id = `someone/else#9\n${'x'.repeat(500)}`;
      const t = settle(CARD_FAILS, {
        change: (m) => {
          Object.assign(leafOf(m, CARD), {
            id,
            via: [`${THIS_REPO}#505`, id],
          });
        },
      });
      const [note] = JSON.parse(t.r.stdout).comments;
      expect(note.target).not.toContain('\n');
      expect(note.target.length).toBeLessThanOrEqual(201);
      expect(t.told.github).toEqual([]);
    });
  });

  describe('the trust source', () => {
    it('a manifest ledger other than the operator ledger is refused, even inside the tree', () => {
      const t = settle(ALL_PASS, {
        change: (m) => {
          m.ledger = REF_FILE;
        },
      });
      expectRefused(t, /not the ledger this verdict was told to trust/);
    });

    it('a ticket only the trial branch ledger names is not trusted', () => {
      // A row the default branch does not name it on, pushed to the head only.
      const t = settle(CARD_FAILS, {
        change: (m) => {
          Object.assign(leafOf(m, CARD), { id: 'someone/else#9', via: [] });
        },
        after: (s) => {
          git(s.repo, 'fetch', '-q', 'origin', 'canary/trial');
          git(s.repo, 'checkout', '-q', 'FETCH_HEAD');
          const file = path.join(s.repo, LEDGER);
          const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
          doc.entries = rowNamed(CARD, 'someone/else#9')(doc.entries);
          fs.writeFileSync(file, JSON.stringify(doc));
          git(s.repo, 'commit', '-qam', 'head only');
          git(s.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/canary/trial');
          git(s.repo, 'checkout', '-q', 'main');
        },
      });
      expectRefused(t, /not named by its ledger row/);
    });

    it('a row the default branch does not have is refused (a trial on another branch)', () => {
      const t = settle(CARD_FAILS, {
        after: (s) =>
          onMain(s.repo, (entries) => entries.filter((e) => e.test !== CARD)),
      });
      expectRefused(t, /not on the default branch/);
    });

    it('a default branch gh cannot name is refused', () => {
      const t = settle(ALL_PASS, {
        after: (_s, h) => {
          h.state.defaultBranch = '';
        },
      });
      expectRefused(t, /default branch/);
    });
  });

  describe('the default branch is read from the remote branch, and nowhere else', () => {
    const FORGED = 'someone/else#9';
    const forgedCard = (m: any) =>
      Object.assign(leafOf(m, CARD), { id: FORGED, via: [] });
    const forgedEvent = (m: any) =>
      Object.assign(leafOf(m, EVENT), {
        id: 'CORE-999',
        key: 'CORE-999',
        via: [],
      });

    /** A commit naming `issue` on `test`'s row, on no branch; returns its id. */
    function looseCommit(repo: string, test: string, issue: string) {
      git(repo, 'checkout', '-q', '--detach');
      const file = path.join(repo, LEDGER);
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.entries = rowNamed(test, issue)(doc.entries);
      fs.writeFileSync(file, JSON.stringify(doc));
      git(repo, 'commit', '-qam', 'loose');
      const sha = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'checkout', '-q', 'main');
      return sha;
    }

    it('a tag named after the default branch does not replace it (GitHub)', () => {
      const t = settle(CARD_FAILS, {
        change: forgedCard,
        after: (s) => {
          const sha = looseCommit(s.repo, CARD, FORGED);
          git(s.repo, 'push', '-q', 'origin', `${sha}:refs/tags/main`);
        },
      });
      expectRefused(t, /not named by its ledger row/);
    });

    it('a tag named after the default branch does not replace it (Jira)', () => {
      const t = settle(EVENT_FAILS, {
        change: forgedEvent,
        after: (s) => {
          const sha = looseCommit(s.repo, EVENT, 'CORE-999');
          git(s.repo, 'push', '-q', 'origin', `${sha}:refs/tags/main`);
        },
      });
      expectRefused(t, /not named by its ledger row/);
    });

    it("the operator's local HEAD is not the trust source", () => {
      const t = settle(CARD_FAILS, {
        change: forgedCard,
        after: (s) => onLocalMainOnly(s.repo, rowNamed(CARD, FORGED)),
      });
      expectRefused(t, /not named by its ledger row/);
    });

    /** Commit a ledger change on the operator's main, and do not push it. */
    function onLocalMainOnly(repo: string, edit: (e: any[]) => any[]) {
      const file = path.join(repo, LEDGER);
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.entries = edit(doc.entries);
      fs.writeFileSync(file, JSON.stringify(doc));
      git(repo, 'commit', '-qam', 'local only');
    }

    it('a fetch of the default branch that fails refuses the settle', () => {
      const t = settle(ALL_PASS, {
        after: (_s, h) => {
          const real = h.run;
          h.run = (cmd, args, o) =>
            cmd === 'git' &&
            args.includes('fetch') &&
            args.some((a) => a === 'main' || a.includes('refs/heads/main'))
              ? { status: 1, stdout: '', stderr: 'unreachable', error: '' }
              : real(cmd, args, o);
        },
      });
      expectRefused(t, /git fetch failed/);
    });

    it('a default branch with another name is the one read', () => {
      const t = settle(CARD_FAILS, {
        after: (s, h) => {
          git(s.origin, 'branch', '-m', 'main', 'trunk');
          h.state.defaultBranch = 'trunk';
        },
      });
      expect(t.r.stderr).toBe('');
      expect(t.r.code).toBe(0);
      expect(t.told.github).toHaveLength(1);
    });

    it('a repository gh cannot name is refused', () => {
      const t = settle(CARD_FAILS, {
        after: (_s, h) => {
          h.state.repoName = '';
        },
      });
      expectRefused(t, /which repository/);
    });

    it('a ticket only a lower-priority source names is refused', () => {
      // V2's `issue` names #505, so its marker comment's #502 is not its ticket.
      const t = settle(
        { ...ALL_PASS, v2: 'unexpected' },
        {
          change: (m) => {
            Object.assign(leafOf(m, V2), { id: `${THIS_REPO}#502`, via: [] });
          },
        },
      );
      expectRefused(t, /not named by its ledger row/);
    });
  });

  describe('the head', () => {
    it('a head that is the default branch is refused, and the branch does not move', () => {
      const t = settle(ALL_PASS, {
        after: (_s, h) => {
          h.state.headRefName = 'main';
        },
      });
      expectRefused(t, /is the default branch/);
      expect(git(t.origin, 'log', '--format=%s', 'refs/heads/main')).toBe(
        'suite',
      );
    });

    it('a tag named after the head does not replace it', () => {
      const t = settle(ALL_PASS, {
        after: (s) => {
          git(s.origin, 'tag', 'canary/trial', 'refs/heads/main');
        },
      });
      expect(t.r.stderr).toBe('');
      expect(t.r.code).toBe(0);
      expect(
        git(t.origin, 'log', '-1', '--format=%s', 'refs/heads/canary/trial'),
      ).toMatch(/release 3 trial-passed/);
    });

    it('a head name cannot act as a git option', () => {
      const dir = mkTmp();
      const marker = path.join(dir, 'ran');
      const t = settle(ALL_PASS, {
        after: (_s, h) => {
          h.state.headRefName = `--upload-pack=touch ${marker}`;
        },
      });
      expect(t.r.code).not.toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  describe.skipIf(process.platform === 'win32')(
    'nothing from the trial branch runs on the operator machine',
    () => {
      const HOOKS = [
        'pre-commit',
        'prepare-commit-msg',
        'commit-msg',
        'post-commit',
        'post-checkout',
        'pre-push',
        'reference-transaction',
        'post-index-change',
      ];
      const PLANTED = 'planted.sh';
      const script = (marker: string) => `#!/bin/sh\necho ran >> "${marker}"\n`;
      const writeExec = (file: string, text: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        fs.chmodSync(file, 0o755);
      };
      const plantHooks = (dir: string, text: string) =>
        HOOKS.forEach((h) => writeExec(path.join(dir, h), text));
      /** A program at the trial branch's root, and optional other tracked files. */
      const plantOnTrial = (
        repo: string,
        marker: string,
        more: () => void = () => {},
      ) =>
        onTrialBranch(repo, () => {
          writeExec(path.join(repo, PLANTED), script(marker));
          more();
        });
      const setConfig = (repo: string, cfg: Record<string, string>) =>
        Object.entries(cfg).forEach(([k, v]) => git(repo, 'config', k, v));
      const attributes = (repo: string, line: string) =>
        fs.writeFileSync(path.join(repo, '.gitattributes'), `${line}\n`);

      /** Settled for real, and nothing recorded that it ran. */
      function expectSettledUnseen(t: Settled, marker: string) {
        expect(fs.existsSync(marker)).toBe(false);
        expect(t.r.stderr).toBe('');
        expect(t.r.code).toBe(0);
        expect(git(t.origin, 'rev-parse', 'refs/heads/canary/trial')).not.toBe(
          t.head,
        );
      }

      /** Each case gets the temp marker, then arranges its plant and config. */
      const cases: [string, (s: Suite, marker: string) => void][] = [
        [
          'a relative core.hooksPath with hooks on the trial branch',
          (s, m) => {
            plantOnTrial(s.repo, m, () =>
              plantHooks(path.join(s.repo, '.hooks'), script(m)),
            );
            setConfig(s.repo, { 'core.hooksPath': '.hooks' });
          },
        ],
        [
          'an absolute core.hooksPath',
          (s, m) => {
            const dir = mkTmp();
            plantHooks(dir, script(m));
            setConfig(s.repo, { 'core.hooksPath': dir });
          },
        ],
        [
          'no core.hooksPath, with hooks in .git/hooks',
          (s, m) => plantHooks(path.join(s.repo, '.git/hooks'), script(m)),
        ],
        [
          'an installed hook that runs a script from the worktree',
          (s, m) => {
            plantOnTrial(s.repo, m);
            plantHooks(
              path.join(s.repo, '.git/hooks'),
              `#!/bin/sh\n[ -x ./${PLANTED} ] && ./${PLANTED} < /dev/null\nexit 0\n`,
            );
          },
        ],
        [
          'hooks set through includeIf, only for the worktree',
          (s, m) => {
            const dir = mkTmp();
            plantHooks(dir, script(m));
            const inc = path.join(mkTmp(), 'inc.gitconfig');
            fs.writeFileSync(inc, `[core]\n\thooksPath = ${dir}\n`);
            setConfig(s.repo, { 'includeIf.gitdir:**/worktrees/**.path': inc });
          },
        ],
        ...(['smudge', 'clean', 'process'] as const).map(
          (key): [string, (s: Suite, marker: string) => void] => [
            `a relative filter.*.${key}`,
            (s, m) => {
              plantOnTrial(s.repo, m, () => attributes(s.repo, '* filter=fx'));
              setConfig(s.repo, {
                [`filter.fx.${key}`]: `./${PLANTED}`,
                'filter.fx.required': 'true',
              });
            },
          ],
        ),
        [
          'a relative git-lfs style filter',
          (s, m) => {
            plantOnTrial(s.repo, m, () => attributes(s.repo, '* filter=lfs'));
            setConfig(s.repo, {
              'filter.lfs.process': `./${PLANTED} filter-process`,
              'filter.lfs.required': 'true',
            });
          },
        ],
        [
          'a relative core.fsmonitor',
          (s, m) => {
            plantOnTrial(s.repo, m);
            setConfig(s.repo, { 'core.fsmonitor': `./${PLANTED}` });
          },
        ],
        [
          'a relative gpg.program with commit.gpgsign',
          (s, m) => {
            plantOnTrial(s.repo, m);
            setConfig(s.repo, {
              'commit.gpgsign': 'true',
              'gpg.program': `./${PLANTED}`,
            });
          },
        ],
        [
          'a relative gpg.ssh.program with commit.gpgsign',
          (s, m) => {
            plantOnTrial(s.repo, m);
            setConfig(s.repo, {
              'commit.gpgsign': 'true',
              'gpg.format': 'ssh',
              'user.signingkey': 'key::ssh-ed25519 AAAA',
              'gpg.ssh.program': `./${PLANTED}`,
            });
          },
        ],
      ];

      it.each(cases)('%s', (_n, arrange) => {
        const marker = path.join(mkTmp(), 'ran');
        const t = settle(ALL_PASS, { after: (s) => arrange(s, marker) });
        expectSettledUnseen(t, marker);
      });

      it('a filter with no required key is still switched off', () => {
        const marker = path.join(mkTmp(), 'ran');
        const t = settle(ALL_PASS, {
          after: (s) => {
            plantOnTrial(s.repo, marker, () =>
              attributes(s.repo, '* filter=fx'),
            );
            setConfig(s.repo, { 'filter.fx.smudge': `./${PLANTED}` });
          },
        });
        expectSettledUnseen(t, marker);
      });

      it.each(['filter.a=b.smudge', 'hook.a=b.event'])(
        'a %s name that -c cannot express is refused',
        (key) => {
          const t = settle(ALL_PASS, {
            after: (s) => setConfig(s.repo, { [key]: 'x' }),
          });
          expectRefused(t, /cannot be switched off/);
        },
      );

      describe('config-defined hooks', () => {
        const EVENTS = ['pre-commit', 'post-checkout', 'reference-transaction'];
        /** Git before config-defined hooks ignores them: nothing to prove there. */
        const firesHere = (() => {
          const dir = mkTmp();
          const marker = path.join(dir, 'fired');
          const repo = path.join(dir, 'r');
          fs.mkdirSync(repo);
          const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
          const g = (...a: string[]) =>
            spawnSync(
              'git',
              ['-C', repo, '-c', 'user.name=a', '-c', 'user.email=a@b', ...a],
              { env },
            );
          g('init', '-q');
          g('config', 'hook.ctl.event', 'pre-commit');
          g('config', 'hook.ctl.command', `touch "${marker}"`);
          g('commit', '-q', '--allow-empty', '-m', 'x');
          return fs.existsSync(marker);
        })();
        const hookIn = (file: string[], marker: string) => {
          const set = (...a: string[]) => {
            const r = spawnSync('git', ['config', ...file, ...a], {
              encoding: 'utf8',
            });
            if (r.status !== 0) throw new Error(r.stderr);
          };
          for (const e of EVENTS) set('--add', 'hook.planted.event', e);
          set('hook.planted.command', `pwd >> "${marker}"`);
        };

        // Runs on every git: the setting is passed whether or not git honours it.
        it('every git call switches a configured hook off by name', () => {
          const t = settle(ALL_PASS, {
            after: (s) =>
              hookIn(['--file', path.join(s.repo, '.git/config')], '/dev/null'),
          });
          expect(t.r.stderr).toBe('');
          const push = t.h.calls.filter((c) => c.args.includes('push')).at(-1)!;
          expect(push.args).toContain('hook.planted.enabled=false');
        });

        it.skipIf(!firesHere)(
          'a repository config hook does not run (needs a git with config-defined hooks; skipped on older git, which ignores them)',
          () => {
            const marker = path.join(mkTmp(), 'ran');
            const t = settle(ALL_PASS, {
              after: (s) =>
                hookIn(['--file', path.join(s.repo, '.git/config')], marker),
            });
            expectSettledUnseen(t, marker);
          },
        );

        it.skipIf(!firesHere)(
          'a global config hook does not run (needs a git with config-defined hooks; skipped on older git, which ignores them)',
          () => {
            const marker = path.join(mkTmp(), 'ran');
            const global = path.join(mkTmp(), 'global.gitconfig');
            fs.writeFileSync(global, '');
            const t = settle(ALL_PASS, {
              after: () => {
                hookIn(['--file', global], marker);
                vi.stubEnv('GIT_CONFIG_GLOBAL', global);
              },
            });
            // A local origin's receive-pack gets a clean config environment, so a
            // global hook fires there, server side; a real remote has no such step.
            const where = fs.existsSync(marker)
              ? fs.readFileSync(marker, 'utf8').trim().split('\n')
              : [];
            expect(where.filter((d) => !d.endsWith('origin.git'))).toEqual([]);
            expect(t.r.stderr).toBe('');
            expect(t.r.code).toBe(0);
          },
        );
      });

      it.each([
        ['remote.origin.promisor', 'true'],
        ['extensions.partialClone', 'origin'],
      ])(
        'a partial clone (%s) is refused before anything is written',
        (k, v) => {
          const t = settle(ALL_PASS, {
            after: (s) => setConfig(s.repo, { [k]: v }),
          });
          expectRefused(t, /partial clone/);
          expect(t.h.calls.some((c) => c.args.includes('fetch'))).toBe(false);
        },
      );

      it('remote.origin.promisor=false is not a partial clone', () => {
        const t = settle(ALL_PASS, {
          after: (s) =>
            setConfig(s.repo, { 'remote.origin.promisor': 'false' }),
        });
        expect(t.r.stderr).toBe('');
        expect(t.r.code).toBe(0);
      });

      it('the push runs from the operator repository, not the trial worktree', () => {
        // Stands in for core.sshCommand and credential.helper, which a local
        // origin never calls: a relative program resolves from where git runs.
        const marker = path.join(mkTmp(), 'ran');
        const t = settle(ALL_PASS, {
          after: (s) => {
            plantOnTrial(s.repo, marker);
            setConfig(s.repo, { 'remote.origin.receivepack': `./${PLANTED}` });
          },
        });
        expect(fs.existsSync(marker)).toBe(false);
        expect(t.r.code).not.toBe(0); // no such program in the operator's tree
        expect(t.r.stderr).toMatch(/git push failed/);
      });

      it('auth settings are left alone on the push', () => {
        const t = settle(ALL_PASS);
        const push = t.h.calls.filter((c) => c.args.includes('push')).at(-1)!;
        expect(push.args.join(' ')).not.toMatch(
          /core\.sshCommand|credential\.helper|core\.askPass/,
        );
        expect(push.args[push.args.indexOf('-C') + 1]).toBe(t.repo);
      });

      it('submodule.recurse does not populate a submodule the branch names', () => {
        const sub = mkTmp();
        git(sub, 'init', '-q', '-b', 'main');
        git(sub, 'commit', '-q', '--allow-empty', '-m', 'sub');
        const sha = git(sub, 'rev-parse', 'HEAD');
        const t = settle(ALL_PASS, {
          after: (s) => {
            onTrialBranch(s.repo, () => {
              fs.writeFileSync(
                path.join(s.repo, '.gitmodules'),
                `[submodule "sub"]\n\tpath = sub\n\turl = ${sub}\n`,
              );
              git(
                s.repo,
                'update-index',
                '--add',
                '--cacheinfo',
                `160000,${sha},sub`,
              );
            });
            setConfig(s.repo, { 'submodule.recurse': 'true' });
          },
        });
        expect(t.r.stderr).toBe('');
        expect(t.r.code).toBe(0);
      });

      it('with filters off, a filtered file goes back byte for byte', () => {
        // A required filter that would change the bytes if it ran: the rebuilt
        // file must still be the stored blob, as a pointer file would need.
        const upper = path.join(mkTmp(), 'upper.sh');
        writeExec(upper, '#!/bin/sh\ntr a-z A-Z\n');
        let blob = '';
        const t = settle(
          { card: 'flaky', event: 'flaky', v2: 'flaky' },
          {
            before: (s) => {
              attributes(s.repo, `${REF_FILE} filter=lfs`);
              git(s.repo, 'add', '-A');
              git(s.repo, 'commit', '-q', '-m', 'attributes');
              git(s.repo, 'push', '-q', 'origin', 'main');
            },
            after: (s) => {
              blob = git(s.origin, 'show', `refs/heads/main:${REF_FILE}`);
              setConfig(s.repo, {
                'filter.lfs.clean': upper,
                'filter.lfs.smudge': upper,
                'filter.lfs.required': 'true',
              });
            },
          },
        );
        expect(t.r.stderr).toBe('');
        const after = git(
          t.origin,
          'show',
          `refs/heads/canary/trial:${REF_FILE}`,
        );
        expect(after).toBe(blob);
      });

      describe("this repository's own hook setup", () => {
        const HOOK = fs.readFileSync(
          path.join(HERE, '..', '..', '..', '.githooks', 'pre-commit'),
          'utf8',
        );
        const INPUTS = ['docs/roadmap.md', '.harness/security/timeline.json'];

        /** Planted scripts and changed inputs, for the trial branch. */
        function plantOwn(repo: string, marker: string) {
          const planted = `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'ran');\n`;
          fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
          for (const name of [
            'roadmap_comment_guard.mjs',
            'security_ledger.mjs',
          ])
            fs.writeFileSync(path.join(repo, 'scripts', name), planted);
          for (const file of INPUTS)
            fs.writeFileSync(path.join(repo, file), 'on the trial\n');
        }

        /** The real hook on main; on the trial branch, changed inputs and planted scripts. */
        function ownHook(hooksPath: (repo: string) => string, marker: string) {
          const forge = (m: any) =>
            m.lifts.push(
              ...INPUTS.map((file) => ({
                ...structuredClone(m.lifts[0]),
                test: `never in the run ${file}`,
                file,
              })),
            );
          return settle(ALL_PASS, {
            change: forge,
            before: (s) => {
              writeExec(path.join(s.repo, '.githooks/pre-commit'), HOOK);
              for (const f of INPUTS) {
                fs.mkdirSync(path.dirname(path.join(s.repo, f)), {
                  recursive: true,
                });
                fs.writeFileSync(path.join(s.repo, f), 'on main\n');
              }
              git(s.repo, 'add', '-A');
              git(s.repo, 'commit', '-q', '-m', 'own hook');
              git(s.repo, 'push', '-q', 'origin', 'main');
            },
            after: (s) => {
              onTrialBranch(s.repo, () => plantOwn(s.repo, marker));
              setConfig(s.repo, { 'core.hooksPath': hooksPath(s.repo) });
            },
          });
        }

        it.each([
          ['relative, as AGENTS.md documents', () => '.githooks'],
          ['absolute', (repo: string) => path.join(repo, '.githooks')],
        ])(
          'core.hooksPath %s: settles, and no planted script runs',
          (_n, p) => {
            const marker = path.join(mkTmp(), 'ran');
            const t = ownHook(p, marker);
            expectSettledUnseen(t, marker);
            expect(
              git(t.origin, 'show', 'refs/heads/canary/trial:docs/roadmap.md'),
            ).toBe('on main');
          },
        );
      });
    },
  );

  describe('the shape of a lift', () => {
    it.each([
      '.git/hooks/pre-commit',
      '.GIT/config',
      'sub/.git/config',
      '.git./config',
      'git~1/config',
    ])(
      'a lift file %s is refused, even for a lift the run never saw',
      (file) => {
        const t = settle(ALL_PASS, {
          change: (m) => {
            m.lifts.push({
              ...structuredClone(m.lifts[0]),
              test: 'never in the run',
              file,
            });
          },
        });
        expectRefused(t, /names a \.git directory/);
      },
    );

    it('a ledger path with a .git segment is refused', () => {
      const t = settle(ALL_PASS, {
        change: (m) => {
          m.ledger = '.git/quarantine.json';
        },
      });
      expectRefused(t, /names a \.git directory/);
    });

    it('a repeated lift is refused, and its ticket hears nothing', () => {
      const t = settle(CARD_FAILS, {
        change: (m) => {
          const lift = liftOf(m, CARD);
          m.lifts.push(structuredClone(lift), structuredClone(lift));
        },
      });
      expectRefused(t, /more than once/);
    });

    it.each([
      ['empty blockers', (l: any) => (l.blockers = [])],
      ['no blockers', (l: any) => delete l.blockers],
      ['blockers that are not a list', (l: any) => (l.blockers = 'x')],
    ])('a failing lift with %s is refused', (_n, mangle) => {
      const t = settle(CARD_FAILS, {
        change: (m) => {
          mangle(liftOf(m, CARD));
        },
      });
      expectRefused(t, /no blocker/);
    });
  });

  describe('the report shows manifest strings as plain, bounded text', () => {
    const LONG = 'x'.repeat(500);
    const report_ = (t: Settled, ...extra: string[]) =>
      callMain(
        [
          'verdict',
          '--repo',
          t.repo,
          '--pr',
          '77',
          '--artifact',
          'playwright-json',
          ...extra,
        ],
        { run: t.h.run, env: JIRA_ENV },
      );
    const forgedLift = () =>
      settle(ALL_PASS, {
        change: (m) => {
          m.lifts.push({
            ...structuredClone(m.lifts[0]),
            test: `line one\nline two${LONG}`,
            file: `dir\nfile${LONG}`,
          });
        },
      });

    it('plain verdict', () => {
      const r = report_(forgedLift());
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain('line one\nline two');
      expect(r.stdout).not.toContain('dir\nfile');
      expect(r.stdout).not.toContain(LONG);
    });

    it('--json', () => {
      const doc = JSON.parse(report_(forgedLift(), '--json').stdout);
      const added = doc.tests.at(-1);
      expect(added.test).toBe(`line one line two${'x'.repeat(183)}…`);
      expect(added.file).not.toContain('\n');
      expect(added.file.length).toBeLessThanOrEqual(201);
    });
  });

  describe('ledgerRows are checked against the trusted ledger', () => {
    const OTHER = 'a row whose ticket cannot be read';

    it('a row in another file is refused, even at the same marker line', () => {
      const OTHER_FILE = 'tests/api/other.spec.js';
      const row = {
        test: 'a row in another file',
        file: OTHER_FILE,
        kind: 'skipped',
        marker: 'test.skip',
      };
      const t = settle(ALL_PASS, {
        before: (s) => {
          const lines = fs
            .readFileSync(path.join(s.repo, REF_FILE), 'utf8')
            .split('\n');
          const at = lines.findIndex((l) => l.includes(EVENT));
          fs.writeFileSync(
            path.join(s.repo, OTHER_FILE),
            `${'\n'.repeat(at)}test.skip('${row.test}', async () => {});\n`,
          );
          onMain(s.repo, (entries) => [
            ...entries,
            { ...entries.find((e) => e.test === EVENT), ...row },
          ]);
        },
        change: (m) => {
          liftOf(m, EVENT).ledgerRows.push(row);
        },
      });
      expectRefused(t, /belongs to another marker/);
    });

    it('with no marker on the default branch, another title cannot join the lift', () => {
      const GONE = 'a row for a test that is gone';
      const t = settle(ALL_PASS, {
        change: (m) => {
          const lift = liftOf(m, EVENT);
          lift.ledgerRows.push({ ...lift.ledgerRows[0], test: GONE });
        },
        after: (s) => {
          const file = path.join(s.repo, REF_FILE);
          const src = fs.readFileSync(file, 'utf8');
          fs.writeFileSync(
            file,
            src.replace(`test.skip('${EVENT}'`, `test('${EVENT}'`),
          );
          onMain(s.repo, (entries) => [
            ...entries,
            { ...entries.find((e) => e.test === EVENT), test: GONE },
          ]);
        },
      });
      expectRefused(t, /belongs to another marker/);
    });

    it("a passing lift cannot drop another test's row", () => {
      const t = settle(ALL_PASS, {
        change: (m) => {
          const lift = liftOf(m, EVENT);
          lift.ledgerRows.push({ ...lift.ledgerRows[0], test: OTHER });
        },
      });
      expectRefused(t, /belongs to another marker/);
    });

    it('a row the trusted ledger does not hold is refused', () => {
      const t = settle(ALL_PASS, {
        change: (m) => {
          liftOf(m, EVENT).ledgerRows[0].marker = 'test.fixme';
        },
      });
      expectRefused(t, /not on the default branch/);
    });

    it('a lift that names none of its own rows is refused', () => {
      const t = settle(ALL_PASS, {
        change: (m) => {
          liftOf(m, EVENT).ledgerRows = [];
        },
      });
      expectRefused(t, /no ledger row of its own/);
    });

    it('rows the audit grouped on one marker still settle together', () => {
      const SHORT = 'the warehouse list is unreachable';
      const t = settle(ALL_PASS, {
        before: (s) =>
          onMain(s.repo, (entries) => [
            ...entries,
            { ...entries.find((e) => e.test === CARD), test: SHORT },
          ]),
      });
      expect(t.r.stderr).toBe('');
      expect(t.r.code).toBe(0);
      expect(rowOf(t, CARD)).toBeUndefined();
      expect(rowOf(t, SHORT)).toBeUndefined();
    });
  });
});

describe('verdict refuses a trial whose head is not in this repository', () => {
  const opened = () => {
    const suite = makeSuite();
    const h = harness({
      results: report({
        card: 'unexpected',
        event: 'expected',
        v2: 'expected',
      }),
    });
    expect(
      callMain(
        ['trial', '--repo', suite.repo, '--yes', '--branch', 'canary/trial'],
        { run: h.run, env: JIRA_ENV },
      ).code,
    ).toBe(0);
    return { ...suite, h };
  };
  const apply = (repo: string, h: ReturnType<typeof harness>) =>
    callMain(
      [
        'verdict',
        '--repo',
        repo,
        '--pr',
        '77',
        '--artifact',
        'playwright-json',
        '--apply',
      ],
      { run: h.run, env: JIRA_ENV },
    );

  // `null` is a gh that did not report the field: not known to be this repo.
  it.each([
    ['a cross-repository head', true],
    ['a head gh did not report on', null],
  ])(
    '%s: exits non-zero, fetches, pushes and comments nothing',
    (_n, cross) => {
      const { repo, origin, h } = opened();
      h.state.isCrossRepository = cross;
      const head = git(origin, 'rev-parse', 'canary/trial');
      h.calls.length = 0;

      const r = apply(repo, h);

      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/not a branch of this repository/);
      expect(git(origin, 'rev-parse', 'canary/trial')).toBe(head);
      expect(h.calls.filter((c) => c.cmd !== 'gh')).toEqual([]);
      expect(h.calls.some((c) => c.args[0] === 'issue')).toBe(false);
    },
  );

  it('a head in this repository still settles', () => {
    const { repo, origin, h } = opened();
    const head = git(origin, 'rev-parse', 'canary/trial');
    expect(apply(repo, h).code).toBe(0);
    expect(git(origin, 'rev-parse', 'canary/trial')).not.toBe(head);
  });
});

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
      const t = tampered(() => {});
      // tampered() ran with the link absent; commit it on the trial branch
      // only, so only the check against the checked-out tree can see it.
      onTrialBranch(t.repo, () => {
        fs.rmSync(path.join(t.repo, '.canary'), { recursive: true });
        fs.symlinkSync(v.dir, path.join(t.repo, '.canary'));
      });
      expect(fs.lstatSync(path.join(t.repo, '.canary')).isSymbolicLink()).toBe(
        false,
      );
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

  it('a Jira blocker whose key is malformed, or not its own id, is refused (it picks the ticket to write to)', () => {
    const jiraOf = (m: any) =>
      m.lifts.find((l: any) => l.test === EVENT).blockers.at(-1);
    expectRefused(
      tampered((m) => {
        jiraOf(m).key = 'CORE-101/../../myself';
      }),
      /not a Jira key/,
    );
    expectRefused(
      tampered((m) => {
        jiraOf(m).key = 'CORE-999';
      }),
      /not a Jira key/,
    );
  });
});

describe('verdict --apply refuses a test file it cannot restore byte for byte', () => {
  // The runner decodes git output as UTF-8, so a non-UTF-8 blob (a git-crypt
  // file, a Latin-1 comment) would come back changed and be pushed (#1573).
  it('a non-UTF-8 file at base is refused: non-zero, named, nothing pushed, no ticket told', () => {
    const suite = makeSuite();
    const abs = path.join(suite.repo, REF_FILE);
    const latin1 = Buffer.from('// caf\xe9 \xff\xfe\n', 'latin1');
    fs.writeFileSync(abs, Buffer.concat([fs.readFileSync(abs), latin1]));
    git(suite.repo, 'commit', '-q', '-am', 'a Latin-1 comment');
    git(suite.repo, 'push', '-q', 'origin', 'main');
    const h = harness({
      results: report({ card: 'flaky', event: 'flaky', v2: 'flaky' }),
    });
    expect(
      callMain(
        ['trial', '--repo', suite.repo, '--yes', '--branch', 'canary/trial'],
        { run: h.run, env: JIRA_ENV },
      ).code,
    ).toBe(0);
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
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not UTF-8 text.*refusing to settle/);
    expect(r.stderr).toContain(REF_FILE);
    expect(git(suite.origin, 'rev-parse', 'canary/trial')).toBe(head);
    expect(h.calls.some((c) => c.args[0] === 'issue')).toBe(false);
  });

  it('a UTF-8 file with multi-byte text still restores byte for byte', () => {
    const suite = makeSuite();
    const abs = path.join(suite.repo, REF_FILE);
    fs.appendFileSync(abs, '// café \u{1F426} ﻿\n');
    git(suite.repo, 'commit', '-q', '-am', 'a UTF-8 comment');
    git(suite.repo, 'push', '-q', 'origin', 'main');
    const h = harness({
      results: report({ card: 'flaky', event: 'flaky', v2: 'flaky' }),
    });
    callMain(
      ['trial', '--repo', suite.repo, '--yes', '--branch', 'canary/trial'],
      { run: h.run, env: JIRA_ENV },
    );
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
    expect(r.stderr).toBe('');
    const blob = (rev: string) =>
      spawnSync('git', ['-C', suite.origin, 'show', `${rev}:${REF_FILE}`])
        .stdout as Buffer;
    expect(blob('canary/trial').equals(blob('main'))).toBe(true);
  });
});
