// canary-unquarantine: the release half of quarantine (#1455).
//
// The fixture under test/fixtures/unquarantine is a synthetic orders/inventory
// suite carrying every quarantine shape the audit must read -- the ledger
// rows, the markers and the comments above them -- with a fake tracker
// standing in for `gh` and Jira so nothing here touches the network.

import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeAll,
  afterAll,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../claude-code/canary-unquarantine/scripts/cli.mjs';
import {
  audit,
  combine,
  resolveRef,
  verdictOf,
  MAX_HANDOFF_DEPTH,
} from '../claude-code/canary-unquarantine/scripts/audit.mjs';
import {
  extractRefs,
  handoffRefs,
  idTokens,
  pickBlocker,
} from '../claude-code/canary-unquarantine/scripts/refs.mjs';
import {
  commentAbove,
  locate,
  maskJs,
  readSource,
} from '../claude-code/canary-unquarantine/scripts/markers.mjs';
import { scanSuite } from '../claude-code/canary-unquarantine/scripts/scan.mjs';
import {
  githubTracker,
  resolveGithubRepo,
} from '../claude-code/canary-unquarantine/scripts/trackers.mjs';
import { jiraTracker } from '../claude-code/canary-unquarantine/scripts/jira.mjs';
import { ABSTAINED_LINE } from '../claude-code/canary-unquarantine/scripts/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'unquarantine');
/**
 * The suite under audit: the committed fixture plus one pytest file written
 * here. A `.py` fixture committed under test/ would be scanned by the repo's
 * entropy ratchet as dead source; generating it keeps it out of that count.
 */
const PY_FIXTURE = [
  '# Fixture for canary-unquarantine. Never executed; read as text only.',
  'import pytest',
  '',
  '',
  '@pytest.mark.skip(reason="blocked by #12")',
  'def test_refund_restocks_items():',
  '    assert False',
  '',
  '',
  'def test_order_total():',
  '    assert 1 + 1 == 2',
  '',
].join('\n');
let SUITE = '';
beforeAll(() => {
  SUITE = fs.mkdtempSync(path.join(os.tmpdir(), 'unquarantine-suite-'));
  fs.cpSync(path.join(FIXTURE, 'suite'), SUITE, { recursive: true });
  fs.mkdirSync(path.join(SUITE, 'tests', 'py'), { recursive: true });
  fs.writeFileSync(
    path.join(SUITE, 'tests', 'py', 'test_orders.py'),
    PY_FIXTURE,
  );
});
afterAll(() => fs.rmSync(SUITE, { recursive: true, force: true }));
const LEDGER = path.join(FIXTURE, 'quarantine.json');
const COMPANY = path.join(FIXTURE, 'company.json');
const TRACKER = JSON.parse(
  fs.readFileSync(path.join(FIXTURE, 'tracker.json'), 'utf8'),
);
const JIRA_ENV = {
  CANARY_JIRA_EMAIL: 'qa@example.com',
  CANARY_JIRA_API_TOKEN: 'not-a-real-token',
  // The only site credentials are sent to; ticket URLs elsewhere abstain.
  CANARY_JIRA_BASE_URL: 'https://acme.atlassian.net',
};

type Result = { status: number; stdout: string; stderr: string; error: string };
type Call = { cmd: string; args: string[]; input?: string };

/**
 * A fake `gh` / `curl`, answering from tracker.json. Every call is recorded
 * so tests can assert what was (and was not) asked.
 */
function fakeRunner(state = TRACKER, overrides: Record<string, Result> = {}) {
  const calls: Call[] = [];
  const ok = (stdout: string): Result => ({
    status: 0,
    stdout,
    stderr: '',
    error: '',
  });
  const notFound: Result = {
    status: 1,
    stdout: '',
    stderr: 'gh: Not Found (HTTP 404)',
    error: '',
  };
  const run = (
    cmd: string,
    args: string[],
    opts: { input?: string } = {},
  ): Result => {
    calls.push({ cmd, args, input: opts.input });
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, result] of Object.entries(overrides)) {
      if (key.includes(pattern)) return result;
    }
    if (cmd === 'gh' && args[0] === 'repo') return ok(`${state.github_repo}\n`);
    if (cmd === 'gh' && args[0] === 'api') {
      const target = args.find((a) => a.startsWith('repos/'))!;
      const m = /^repos\/(.+)\/issues\/(\d+)(\/comments)?$/.exec(target);
      const issue = m && state.github[m[1]]?.[m[2]];
      if (!issue) return notFound;
      if (m![3]) {
        return ok(
          issue.comments
            .map((body: string) => JSON.stringify({ body }))
            .join('\n'),
        );
      }
      const { comments, ...rest } = issue;
      return ok(JSON.stringify(rest));
    }
    if (cmd === 'curl') {
      const url = args[args.length - 1];
      const key2 = /\/issue\/([^?]+)/.exec(url)?.[1] ?? '';
      const t = state.jira?.[decodeURIComponent(key2)];
      if (!t)
        return {
          status: 22,
          stdout: '',
          stderr: 'curl: (22) The requested URL returned error: 404',
          error: '',
        };
      return ok(
        JSON.stringify({
          fields: {
            summary: t.summary,
            status: { statusCategory: { key: t.statusCategory } },
            resolution: t.resolution ? { name: t.resolution } : null,
            assignee: t.assignee ? { displayName: t.assignee } : null,
          },
        }),
      );
    }
    return { status: 127, stdout: '', stderr: `${cmd}: not found`, error: '' };
  };
  return { run, calls };
}

function callMain(argv: string[], deps: object = {}) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void out.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void err.push(a.join(' ')),
  );
  const code = main(argv, deps);
  vi.restoreAllMocks();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const fixtureArgs = (...extra: string[]) => [
  '--repo',
  SUITE,
  '--ledger',
  LEDGER,
  '--company',
  COMPANY,
  ...extra,
];

function auditJson(env: object = JIRA_ENV, runner = fakeRunner()) {
  const r = callMain(fixtureArgs('--json'), { run: runner.run, env });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

const byTest = (doc: any, test: string) =>
  doc.rows.filter((r: any) => r.test === test);
const classOf = (doc: any, test: string) =>
  byTest(doc, test).map((r: any) => r.class);

const tmps: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'unquarantine-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

// --- the fixture, end to end ------------------------------------------------

describe('audit of the fixture suite', () => {
  it('classifies every row and prints the denominator', () => {
    const doc = auditJson();
    expect(doc.checked).toBe(16);
    expect(doc.counts).toEqual({
      candidate: 3,
      blocked: 5,
      stale: 3,
      unlinked: 1,
      abstain: 3,
      removed: 1,
    });
    expect(doc.denominator).toEqual({
      rows_read: 16,
      resolved: 8,
      abstained: 3,
      not_tracker_questions: 5,
    });
    expect(doc.abstained).toBe(true);
  });

  it('a closed issue with no hand-off is a candidate', () => {
    const [row] = byTest(
      auditJson(),
      'FINDING: the warehouse list is unreachable, blocked by a missing permission',
    );
    expect(row.class).toBe('candidate');
    expect(row.blockers.map((b: any) => b.id)).toEqual([
      'acme/orders-suite#505',
    ]);
  });

  it('closed-to-upstream is NOT fixed: a hand-off to an unreadable upstream ticket abstains', () => {
    const [row] = byTest(
      auditJson(),
      'FINDING: cancelling an order does not restock its items (#501)',
    );
    expect(row.class).toBe('abstain');
    expect(row.blockers).toHaveLength(1);
    expect(row.blockers[0].id).toBe('TRK-1001');
    expect(row.blockers[0].via).toEqual(['acme/orders-suite#501', 'TRK-1001']);
    expect(row.why).toMatch(
      /Jira project TRK is not in company\.json jira_projects/,
    );
  });

  it('closed-to-upstream is NOT fixed: an open upstream ticket blocks, naming its owner', () => {
    const state = structuredClone(TRACKER);
    state.jira['TRK-1001'] = {
      statusCategory: 'indeterminate',
      summary: 'x',
      assignee: 'Platform Team',
    };
    const company = path.join(mkTmp(), 'company.json');
    fs.writeFileSync(
      company,
      JSON.stringify({ jira_projects: ['CORE', 'TRK'] }),
    );
    const r = callMain(
      ['--repo', SUITE, '--ledger', LEDGER, '--company', company, '--json'],
      {
        run: fakeRunner(state).run,
        env: JIRA_ENV,
      },
    );
    const [row] = byTest(
      JSON.parse(r.stdout),
      'FINDING: cancelling an order does not restock its items (#501)',
    );
    expect(row.class).toBe('blocked');
    expect(row.why).toContain(
      'TRK-1001 is open, owner Platform Team (via acme/orders-suite#501)',
    );
  });

  it('follows a hand-off to a configured Jira project that is done: candidate', () => {
    const [row] = byTest(
      auditJson(),
      'FINDING: stock levels answer a proxy 502, not application data',
    );
    expect(row.class).toBe('candidate');
    expect(row.blockers[0].via).toEqual(['acme/orders-suite#506', 'CORE-101']);
  });

  it('the same hand-off abstains when Jira has no credentials', () => {
    const [row] = byTest(
      auditJson({ CANARY_JIRA_BASE_URL: JIRA_ENV.CANARY_JIRA_BASE_URL }),
      'FINDING: stock levels answer a proxy 502, not application data',
    );
    expect(row.class).toBe('abstain');
    expect(row.why).toMatch(
      /Jira is unreachable for CORE-101: set CANARY_JIRA_EMAIL/,
    );
  });

  it('never puts Jira credentials on the command line', () => {
    const runner = fakeRunner();
    auditJson(JIRA_ENV, runner);
    const curls = runner.calls.filter((c) => c.cmd === 'curl');
    expect(curls.length).toBeGreaterThan(0);
    for (const c of curls) {
      expect(c.args.join(' ')).not.toContain('not-a-real-token');
      expect(c.input).toContain('not-a-real-token');
    }
  });

  it('a hand-off list narrows to the line naming the row’s own case id', () => {
    const [row] = byTest(
      auditJson(),
      'CASE-065 a reservation carries the configured expiry',
    );
    expect(row.class).toBe('blocked');
    expect(row.blockers.map((b: any) => b.id)).toEqual([
      'acme/orders-suite#509',
    ]);
    expect(row.why).toContain('owner @grace (via acme/orders-suite#507)');
  });

  it('without a case id, every hand-off target counts (conservatively)', () => {
    const [row] = byTest(
      auditJson(),
      'a reservation lapses 60 days after the order',
    );
    expect(row.class).toBe('blocked');
    // Every key on a hand-off line is believed, so another row's case id
    // reads as a ticket here too: it cannot be read, which leans blocked.
    expect(row.blockers.map((b: any) => b.id).sort()).toEqual([
      'CASE-065',
      'acme/orders-suite#508',
      'acme/orders-suite#509',
    ]);
  });

  it('blocked rows name the open blocker and its owner', () => {
    const doc = auditJson();
    expect(
      byTest(doc, 'BULK bulk orders -- approval-gated @regression')[0].why,
    ).toBe('acme/orders-suite#502 is open, owner @grace');
    expect(
      byTest(doc, 'a 100-unit order reserves stock and only that')[0].why,
    ).toBe('acme/orders-suite#504 is open, owner unassigned');
  });

  it('a runtime skip inside the body is found, with the comment above the call', () => {
    const [row] = byTest(
      auditJson(),
      'CASE-030 a confirmation notice is sent when a bulk order is accepted',
    );
    expect(row).toMatchObject({
      class: 'blocked',
      runtime: true,
      source: 'comment',
      named: ['#503'],
    });
  });

  it('a runtime guard named by a suite helper is found from the ledger marker', () => {
    const [row] = byTest(
      auditJson(),
      'a 100-unit order reserves stock and only that',
    );
    expect(row).toMatchObject({
      runtime: true,
      source: 'reason',
      named: ['#504'],
    });
  });

  it('the v2 issue field outranks the comment above the marker', () => {
    const [row] = byTest(
      auditJson(),
      'a v2 row whose issue field outranks the comment',
    );
    expect(row).toMatchObject({
      class: 'candidate',
      source: 'issue',
      named: ['#505'],
    });
  });

  it('a tracker that refuses to answer abstains, with its error', () => {
    const [row] = byTest(auditJson(), 'a row whose ticket cannot be read');
    expect(row.class).toBe('abstain');
    expect(row.why).toMatch(/HTTP 404/);
  });

  it('a row with no reference anywhere is unlinked', () => {
    expect(classOf(auditJson(), 'an unlinked parked case')).toEqual([
      'unlinked',
    ]);
  });

  it('a lifted describe.skip leaves its rows stale, the duplicate marked, and the phantom removal stale', () => {
    const rows = byTest(
      auditJson(),
      'POST /customers rejects malformed create payloads',
    );
    expect(rows.map((r: any) => r.class)).toEqual(['stale', 'stale', 'stale']);
    expect(rows[0].why).toBe('the test is present but it is no longer skipped');
    expect(rows[1].duplicateOf).toBe(0);
    expect(rows[2].why).toMatch(/phantom removal/);
  });

  it('a removed test that is really gone is a deletion record, not a candidate', () => {
    expect(classOf(auditJson(), 'an old deleted test')).toEqual(['removed']);
  });

  it('a Jira key named directly in the comment abstains when its project is not configured', () => {
    const [row] = byTest(
      auditJson(),
      'an empty JSON body is rejected in the body',
    );
    expect(row).toMatchObject({ class: 'abstain', named: ['TRK-1002'] });
  });

  it('lists unledgered markers: a tag, a pytest decorator; never fixture source or comments', () => {
    const doc = auditJson();
    const listed = doc.unledgered.map((m: any) => [
      m.file,
      m.test,
      m.marker,
      m.names,
    ]);
    expect(listed).toEqual([
      [
        'tests/api/tagged.spec.js',
        'a refund posts a credit @known-failure',
        '@known-failure',
        ['CORE-202'],
      ],
      [
        'tests/py/test_orders.py',
        'test_refund_restocks_items',
        'pytest.mark.skip(reason="blocked by #12")',
        ['#12'],
      ],
    ]);
  });

  it('human output leads with the denominator and never says clear while abstaining', () => {
    const r = callMain(fixtureArgs(), { run: fakeRunner().run, env: JIRA_ENV });
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[2]).toMatch(/^Denominator: 16 ledger row\(s\) read/);
    expect(r.stdout).toContain('Abstained on 3 of 16 row(s)');
    expect(r.stdout).not.toContain('nothing to release');
  });
});

// --- exit codes -------------------------------------------------------------

describe('exit codes', () => {
  it('is advisory by default', () => {
    expect(
      callMain(fixtureArgs(), { run: fakeRunner().run, env: JIRA_ENV }).code,
    ).toBe(0);
  });

  it('--strict exits 1 when something needs action (outranks the abstention)', () => {
    expect(
      callMain(fixtureArgs('--strict'), {
        run: fakeRunner().run,
        env: JIRA_ENV,
      }).code,
    ).toBe(1);
  });

  it('--strict exits 3 when the only open question is an abstention', () => {
    const dir = mkTmp();
    const ledgerPath = path.join(dir, 'q.json');
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        entries: [
          {
            test: 'a row whose ticket cannot be read',
            file: 'tests/api/reference.spec.js',
            kind: 'skipped',
            marker: 'test.skip',
          },
        ],
      }),
    );
    const r = callMain(
      [
        '--repo',
        SUITE,
        '--ledger',
        ledgerPath,
        '--company',
        COMPANY,
        '--no-scan',
        '--strict',
      ],
      {
        run: fakeRunner().run,
        env: {},
      },
    );
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('Abstained on 1 of 1 row(s)');
  });

  it('--strict exits 0 and says clear only when every row is blocked on an open ticket', () => {
    const dir = mkTmp();
    const ledgerPath = path.join(dir, 'q.json');
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        entries: [
          {
            test: 'BULK bulk orders -- approval-gated @regression',
            file: 'tests/orders/bulk.spec.js',
            kind: 'skipped',
            marker: 'describe.skip',
          },
        ],
      }),
    );
    const r = callMain(
      [
        '--repo',
        SUITE,
        '--ledger',
        ledgerPath,
        '--company',
        COMPANY,
        '--no-scan',
        '--strict',
      ],
      {
        run: fakeRunner().run,
        env: {},
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      'All 1 quarantined test(s) are blocked on an open ticket',
    );
  });

  it('a corrupt ledger is a hard error, never an empty audit', () => {
    const dir = mkTmp();
    const ledgerPath = path.join(dir, 'q.json');
    fs.writeFileSync(ledgerPath, '{not json');
    const r = callMain(
      ['--repo', SUITE, '--ledger', ledgerPath, '--company', COMPANY],
      { run: fakeRunner().run },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ledger is not valid JSON/);
  });

  it('rejects an unknown command with exit 2', () => {
    const r = callMain(['release-everything']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unrecognized arguments: release-everything/);
  });
});

// --- zero rows read: the abstention that must never read as clear ----------

describe('zero rows read abstains', () => {
  for (const [label, write] of [
    ['missing ledger', (_p: string) => {}],
    [
      'empty ledger',
      (p: string) =>
        fs.writeFileSync(p, JSON.stringify({ schema_version: 2, entries: [] })),
    ],
  ] as const) {
    it(`${label}: ABSTAINED, exit 3 under --strict, never clear`, () => {
      const dir = mkTmp();
      const ledgerPath = path.join(dir, 'quarantine.json');
      write(ledgerPath);
      const argv = [
        '--repo',
        dir,
        '--ledger',
        ledgerPath,
        '--company',
        COMPANY,
      ];
      const advisory = callMain(argv, { run: fakeRunner().run });
      expect(advisory.code).toBe(0);
      expect(advisory.stdout).toContain(ABSTAINED_LINE);
      expect(advisory.stdout).not.toContain('nothing to release');
      expect(
        callMain([...argv, '--strict'], { run: fakeRunner().run }).code,
      ).toBe(3);
      const json = JSON.parse(
        callMain([...argv, '--json'], { run: fakeRunner().run }).stdout,
      );
      expect(json).toMatchObject({
        checked: 0,
        abstained: true,
        verdict: { status: 'abstained' },
      });
    });
  }

  it('verdictOf: zero rows is abstained even with nothing actionable', () => {
    const den = {
      rows_read: 0,
      resolved: 0,
      abstained: 0,
      not_tracker_questions: 0,
    };
    const counts = {
      candidate: 0,
      blocked: 0,
      stale: 0,
      unlinked: 0,
      abstain: 0,
      removed: 0,
    };
    expect(verdictOf(den, counts, []).status).toBe('abstained');
  });

  it('asks no tracker anything when there is nothing to ask', () => {
    const dir = mkTmp();
    const runner = fakeRunner();
    callMain(
      [
        '--repo',
        dir,
        '--ledger',
        path.join(dir, 'q.json'),
        '--company',
        COMPANY,
      ],
      { run: runner.run },
    );
    expect(runner.calls).toEqual([]);
  });
});

// --- defaults (a test that omits each flag) -----------------------------------

describe('defaults', () => {
  it('reads <repo>/.canary/quarantine.json and company.json when --ledger/--company are omitted', () => {
    const dir = mkTmp();
    fs.cpSync(SUITE, dir, { recursive: true });
    fs.mkdirSync(path.join(dir, '.canary'));
    fs.copyFileSync(LEDGER, path.join(dir, '.canary', 'quarantine.json'));
    fs.copyFileSync(COMPANY, path.join(dir, '.canary', 'company.json'));
    const r = callMain(['--repo', dir, '--json'], {
      run: fakeRunner().run,
      env: JIRA_ENV,
    });
    const doc = JSON.parse(r.stdout);
    expect(doc.checked).toBe(16);
    // company.json was read: CORE is configured, so the CORE-101 hand-off resolved.
    expect(
      byTest(
        doc,
        'FINDING: stock levels answer a proxy 502, not application data',
      )[0].class,
    ).toBe('candidate');
  });

  it('a bare #N resolves against the repo gh reports when --github-repo is omitted', () => {
    const runner = fakeRunner();
    const doc = auditJson(JIRA_ENV, runner);
    expect(doc.github_repo).toBe('acme/orders-suite');
    expect(runner.calls.filter((c) => c.args[0] === 'repo')).toHaveLength(1);
  });

  it('--github-repo overrides the remote, and gh repo view is never asked', () => {
    const runner = fakeRunner();
    callMain(fixtureArgs('--json', '--github-repo', 'acme/orders-suite'), {
      run: runner.run,
      env: JIRA_ENV,
    });
    expect(runner.calls.filter((c) => c.args[0] === 'repo')).toEqual([]);
  });

  it('when gh cannot say which repo a bare #N is in, those rows abstain with the reason', () => {
    const runner = fakeRunner(TRACKER, {
      'gh repo view': {
        status: 1,
        stdout: '',
        stderr: 'no git remotes found',
        error: '',
      },
    });
    const doc = auditJson(JIRA_ENV, runner);
    const [row] = byTest(doc, 'BULK bulk orders -- approval-gated @regression');
    expect(row.class).toBe('abstain');
    expect(row.why).toMatch(
      /cannot tell which repository #502 is in \(gh repo view exited 1: no git remotes found\)/,
    );
  });

  it('tags default to @known-failure / @quarantine, and --tags replaces them', () => {
    const none = JSON.parse(
      callMain(fixtureArgs('--json', '--tags', '@flaky'), {
        run: fakeRunner().run,
        env: JIRA_ENV,
      }).stdout,
    );
    expect(none.unledgered.map((m: any) => m.marker)).toEqual([
      'pytest.mark.skip(reason="blocked by #12")',
    ]);
  });
});

// --- tracker adapters --------------------------------------------------------

describe('GitHub adapter', () => {
  it('a closed issue whose comments cannot be read abstains (a hand-off cannot be ruled out)', () => {
    const runner = fakeRunner(TRACKER, {
      'issues/505/comments': {
        status: 1,
        stdout: '',
        stderr: 'HTTP 502',
        error: '',
      },
    });
    const lookup = githubTracker({
      run: runner.run,
      defaultRepo: 'acme/orders-suite',
    });
    const answer = lookup({
      tracker: 'github',
      repo: null,
      number: 505,
      id: '#505',
    });
    expect(answer.state).toBe('unknown');
    expect(answer.why).toMatch(
      /comments could not be read to rule out a hand-off/,
    );
  });

  it('a gh that cannot start abstains with the spawn error', () => {
    const lookup = githubTracker({
      run: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: 'spawn gh ENOENT',
      }),
      defaultRepo: 'acme/x',
    });
    expect(
      lookup({ tracker: 'github', repo: null, number: 1, id: '#1' }),
    ).toMatchObject({
      state: 'unknown',
      why: expect.stringContaining('spawn gh ENOENT'),
    });
  });

  it('unparseable JSON abstains', () => {
    const lookup = githubTracker({
      run: () => ({ status: 0, stdout: '<html>', stderr: '', error: '' }),
      defaultRepo: 'acme/x',
    });
    expect(
      lookup({ tracker: 'github', repo: null, number: 1, id: '#1' }).state,
    ).toBe('unknown');
  });

  it('caches: one issue is fetched once however many rows name it', () => {
    const runner = fakeRunner();
    auditJson(JIRA_ENV, runner);
    const fetches = runner.calls.filter((c) =>
      c.args.includes('repos/acme/orders-suite/issues/502'),
    );
    expect(fetches).toHaveLength(1);
  });

  it('resolveGithubRepo reports why it could not resolve', () => {
    const r = resolveGithubRepo({
      run: () => ({
        status: 4,
        stdout: '',
        stderr: 'gh auth login required',
        error: '',
      }),
      repo: '.',
    });
    expect(r).toEqual({
      repo: null,
      why: 'gh repo view exited 4: gh auth login required',
    });
  });
});

describe('Jira adapter', () => {
  const ref = {
    tracker: 'jira',
    key: 'CORE-7',
    project: 'CORE',
    base: 'https://acme.atlassian.net',
    id: 'CORE-7',
  };
  const answer = (category: string) => () => ({
    status: 0,
    stdout: JSON.stringify({
      fields: {
        status: { statusCategory: { key: category } },
        resolution: { name: 'Done' },
        summary: 's',
      },
    }),
    stderr: '',
    error: '',
  });

  it('abstains when company.json configures no Jira at all', () => {
    expect(
      jiraTracker({ run: answer('done'), projects: [], env: JIRA_ENV })(ref),
    ).toMatchObject({
      state: 'unknown',
      why: expect.stringMatching(/company\.json has no jira_projects/),
    });
  });

  it('abstains with no site URL', () => {
    const { CANARY_JIRA_BASE_URL: _site, ...noSite } = JIRA_ENV;
    const lookup = jiraTracker({
      run: answer('done'),
      projects: ['CORE'],
      env: noSite,
    });
    expect(lookup({ ...ref, base: null }).why).toMatch(/CANARY_JIRA_BASE_URL/);
  });

  it('done is resolved, new/indeterminate is open, anything else abstains', () => {
    const mk = (c: string) =>
      jiraTracker({ run: answer(c), projects: ['CORE'], env: JIRA_ENV })(ref)
        .state;
    expect(mk('done')).toBe('resolved');
    expect(mk('new')).toBe('open');
    expect(mk('indeterminate')).toBe('open');
    expect(mk('undefined')).toBe('unknown');
  });

  it('a curl failure abstains with its error', () => {
    const lookup = jiraTracker({
      run: () => ({
        status: 6,
        stdout: '',
        stderr: 'curl: (6) Could not resolve host',
        error: '',
      }),
      projects: ['CORE'],
      env: JIRA_ENV,
    });
    expect(lookup(ref).why).toMatch(/Could not resolve host/);
  });

  it('uses CANARY_JIRA_BASE_URL for a bare key', () => {
    let url = '';
    const lookup = jiraTracker({
      run: (_c: string, args: string[]) => {
        url = args[args.length - 1];
        return answer('done')();
      },
      projects: ['CORE'],
      env: { ...JIRA_ENV, CANARY_JIRA_BASE_URL: 'https://jira.example.com/' },
    });
    lookup({ ...ref, base: null });
    expect(url).toBe(
      'https://jira.example.com/rest/api/2/issue/CORE-7?fields=status,resolution,assignee,summary',
    );
  });
});

// --- hand-off resolution -----------------------------------------------------

describe('resolveRef', () => {
  const gh = (n: number) => ({
    tracker: 'github',
    repo: 'a/b',
    number: n,
    id: `a/b#${n}`,
  });

  it('detects a cycle and abstains', () => {
    const lookup = {
      github: (r: any) => ({
        state: 'resolved',
        handoff: [gh(r.number === 1 ? 2 : 1)],
      }),
    };
    const leaves = resolveRef(gh(1), lookup, {});
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({
      state: 'unknown',
      why: expect.stringContaining('hand-off cycle'),
    });
  });

  it(`gives up after ${MAX_HANDOFF_DEPTH} hops`, () => {
    const lookup = {
      github: (r: any) => ({ state: 'resolved', handoff: [gh(r.number + 1)] }),
    };
    const [leaf] = resolveRef(gh(1), lookup, {});
    expect(leaf.state).toBe('unknown');
    expect(leaf.why).toMatch(/hand-off chain of more than/);
  });

  it('a tracker with no adapter abstains', () => {
    expect(resolveRef({ tracker: 'linear', id: 'L-1' }, {}, {})[0].state).toBe(
      'unknown',
    );
  });

  it('combine: an open blocker decides; else an unknown abstains; else candidate', () => {
    expect(combine([{ state: 'open' }, { state: 'unknown' }])).toBe('blocked');
    expect(combine([{ state: 'resolved' }, { state: 'unknown' }])).toBe(
      'abstain',
    );
    expect(combine([{ state: 'resolved' }])).toBe('candidate');
  });
});

// --- references ------------------------------------------------------------------

describe('refs', () => {
  it('a case id in the title is never a ticket', () => {
    const ids = idTokens('CASE-065 a reservation carries an expiry');
    expect(
      extractRefs('CASE-065 is parked against #509', {
        exclude: ids,
        anyBareJira: true,
      }).map((r) => r.id),
    ).toEqual(['#509']);
  });

  it('a bare key needs a blocker phrase or a configured project', () => {
    expect(extractRefs('see ABC-12 for context').map((r) => r.id)).toEqual([]);
    expect(
      extractRefs('see ABC-12 for context', { jiraProjects: ['ABC'] }).map(
        (r) => r.id,
      ),
    ).toEqual(['ABC-12']);
    expect(extractRefs('quarantined against ABC-12').map((r) => r.id)).toEqual([
      'ABC-12',
    ]);
  });

  it('recognises GitHub and Jira URLs, and owner/repo#N', () => {
    const refs = extractRefs(
      'https://github.com/acme/x/issues/7 and acme/y#8 and https://acme.atlassian.net/browse/ZZ-9',
    );
    expect(refs.map((r) => r.id)).toEqual(['acme/x#7', 'acme/y#8', 'ZZ-9']);
    expect(refs[2].base).toBe('https://acme.atlassian.net');
  });

  it('pickBlocker takes the first anchored ref, not every ref in the comment', () => {
    const text =
      'Quarantined against #501.\nTwin of the finding quarantined against #510.';
    expect(pickBlocker(text).refs.map((r) => r.id)).toEqual(['#501']);
  });

  it('pickBlocker falls back to every ref when none is anchored', () => {
    expect(
      pickBlocker('the standing fix is #504, see also #9').refs.map(
        (r) => r.id,
      ),
    ).toEqual(['#504', '#9']);
  });

  it('an HTML entity or a markdown heading is not an issue number', () => {
    expect(extractRefs('&#39; and ## 12 things').map((r) => r.id)).toEqual([]);
  });

  it('handoffRefs reads every hand-off comment, not only the newest (leans blocked)', () => {
    const refs = handoffRefs({
      comments: [
        { body: 'Filed as **UP-1** first.' },
        { body: 'Re-filed as **UP-2** instead.' },
      ],
    });
    expect(refs.map((r) => r.id)).toEqual(['UP-1', 'UP-2']);
  });

  it('handoffRefs: a closed issue with no hand-off line has none', () => {
    expect(
      handoffRefs({
        body: 'Fixed in the last deploy.',
        comments: [{ body: 'Verified on demo, thanks!' }],
      }),
    ).toEqual([]);
  });

  it('handoffRefs never hands an issue off to itself', () => {
    expect(
      handoffRefs(
        { comments: [{ body: 'Tracked in #5 and moved to #6' }] },
        { self: '#5' },
      ).map((r) => r.id),
    ).toEqual(['#6']);
  });
});

// --- markers -----------------------------------------------------------------------

describe('markers', () => {
  it('maskJs blanks comments and (on request) template bodies, keeping offsets', () => {
    const src = "a // test.skip('x')\nconst t = `test.skip('y')`;\n";
    expect(maskJs(src)).toHaveLength(src.length);
    expect(maskJs(src)).not.toContain("test.skip('x')");
    expect(maskJs(src)).toContain("test.skip('y')");
    expect(maskJs(src, { templates: true })).not.toContain("test.skip('y')");
  });

  it('finds a title that starts on the line after the call', () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, 'a.spec.js'),
      "test.skip(\n  'split title',\n  async () => {},\n);\n",
    );
    const loc = locate(readSource(dir, 'a.spec.js'), {
      test: 'split title',
      file: 'a.spec.js',
      marker: 'test.skip',
    });
    expect(loc).toMatchObject({ found: true, marked: true, line: 1 });
  });

  it('matches a ledger title by containment when the code title grew a suffix', () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, 'a.spec.js'),
      "test.skip('FINDING: x (#1) (case A)', () => {});\n",
    );
    const loc = locate(readSource(dir, 'a.spec.js'), {
      test: 'FINDING: x (#1)',
      file: 'a.spec.js',
      marker: 'test.skip',
    });
    expect(loc).toMatchObject({ marked: true, match: 'contains' });
  });

  it('a missing file is stale with the reason', () => {
    expect(
      locate(null, { test: 't', file: 'gone.spec.js', marker: 'test.skip' })
        .why,
    ).toBe('gone.spec.js does not exist');
  });

  it('a runtime marker whose call has gone from the body is stale', () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, 'a.spec.js'),
      "test('t', async () => {\n  expect(1).toBe(1);\n});\n",
    );
    const loc = locate(readSource(dir, 'a.spec.js'), {
      test: 't',
      file: 'a.spec.js',
      marker: 'guard(condition)',
    });
    expect(loc).toMatchObject({
      found: true,
      marked: false,
      why: 'the test is present but no guard(...) call in its body',
    });
  });

  it('pytest skip and xfail decorators are markers', () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, 'test_a.py'),
      '@pytest.mark.xfail(reason="against #3")\ndef test_x():\n    pass\n\ndef test_y():\n    pass\n',
    );
    const src = readSource(dir, 'test_a.py');
    expect(
      locate(src, {
        test: 'test_x',
        file: 'test_a.py',
        marker: 'pytest.mark.xfail',
      }),
    ).toMatchObject({ marked: true, markerLine: 1 });
    expect(
      locate(src, {
        test: 'test_y',
        file: 'test_a.py',
        marker: 'pytest.mark.skip',
      }).marked,
    ).toBe(false);
  });

  it('commentAbove stops at the first non-comment line', () => {
    const lines = [
      '// not mine',
      'const x = 1;',
      '// mine: against #4',
      "test.skip('t', () => {",
    ];
    expect(commentAbove(lines, 4)).toBe(
      "// mine: against #4\ntest.skip('t', () => {",
    );
  });

  it('scanSuite skips node_modules and other build output', () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg', 'tests'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dir, 'node_modules', 'pkg', 'tests', 'a.spec.js'),
      "test.skip('vendored', () => {});\n",
    );
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(
      path.join(dir, 'tests', 'b.spec.js'),
      "test.fixme('mine', () => {});\n",
    );
    const { files, markers } = scanSuite(dir);
    expect(files).toBe(1);
    expect(markers.map((m: any) => m.test)).toEqual(['mine']);
  });
});

// --- the pieces compose without the CLI --------------------------------------------

describe('audit() API', () => {
  it('scan: false lists no unledgered markers', () => {
    const result = audit({ repo: SUITE, rows: [], lookup: {}, scan: false });
    expect(result.unledgered).toEqual([]);
    expect(result.verdict.status).toBe('abstained');
  });
});
