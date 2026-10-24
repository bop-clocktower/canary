// canary-unquarantine: the paths that used to read a still-broken quarantine
// as releasable, or hand Jira credentials to a host nobody configured (#1455).
//
// Each case here is a regression for one review finding: it was reproduced as
// a false green (or a credential leak) before the fix it pins.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  audit,
  resolveRef,
  MAX_HANDOFF_DEPTH,
} from '../claude-code/canary-unquarantine/scripts/audit.mjs';
import {
  jsDeclarations,
  locate,
  maskJs,
  pyDeclarations,
  readSource,
} from '../claude-code/canary-unquarantine/scripts/markers.mjs';
import {
  handoffRefs,
  pickBlocker,
} from '../claude-code/canary-unquarantine/scripts/refs.mjs';
import { scanSuite } from '../claude-code/canary-unquarantine/scripts/scan.mjs';
import {
  jiraCommenter,
  jiraTracker,
} from '../claude-code/canary-unquarantine/scripts/jira.mjs';
import {
  judge,
  junitCases,
} from '../claude-code/canary-unquarantine/scripts/results.mjs';
import { githubTracker } from '../claude-code/canary-unquarantine/scripts/trackers.mjs';
import {
  applyEdits,
  planLift,
} from '../claude-code/canary-unquarantine/scripts/lift.mjs';

type Result = { status: number; stdout: string; stderr: string; error: string };
type Call = { cmd: string; args: string[]; input?: string };

const ok = (value: unknown): Result => ({
  status: 0,
  stdout: typeof value === 'string' ? value : JSON.stringify(value),
  stderr: '',
  error: '',
});

const tmps: string[] = [];
function suite(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unquarantine-fg-'));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

const row = (test: string, file: string, marker: string) => ({
  test,
  file,
  kind: 'skipped',
  marker,
  reason: '',
});

// --- Jira credentials only ever go to the configured site ---------------------

describe('Jira credentials stay on the configured site', () => {
  const ENV = {
    CANARY_JIRA_EMAIL: 'qa@example.com',
    CANARY_JIRA_API_TOKEN: 'not-a-real-token',
    CANARY_JIRA_BASE_URL: 'https://acme.atlassian.net',
  };
  const done = ok({
    fields: {
      status: { statusCategory: { key: 'done' } },
      resolution: { name: 'Done' },
      summary: 's',
    },
  });
  const recorder = () => {
    const calls: Call[] = [];
    const run = (
      cmd: string,
      args: string[],
      opts: { input?: string } = {},
    ) => {
      calls.push({ cmd, args, input: opts.input });
      return done;
    };
    return { run, calls };
  };
  const ref = (base: string | null) => ({
    tracker: 'jira',
    key: 'CORE-7',
    project: 'CORE',
    base,
    id: 'CORE-7',
  });

  it('a ticket URL on a foreign host abstains and sends nothing anywhere', () => {
    const r = recorder();
    const lookup = jiraTracker({ run: r.run, projects: ['CORE'], env: ENV });
    const answer = lookup(ref('https://attacker.example'));
    expect(answer.state).toBe('unknown');
    expect(answer.why).toMatch(/attacker\.example.*not the configured Jira/);
    expect(r.calls).toEqual([]);
  });

  it('a look-alike host or an http:// spelling of the site is foreign too', () => {
    for (const base of [
      'https://acme.atlassian.net.attacker.example',
      'http://acme.atlassian.net',
      'https://acme.atlassian.net:8443',
    ]) {
      const r = recorder();
      const lookup = jiraTracker({ run: r.run, projects: ['CORE'], env: ENV });
      expect(lookup(ref(base)).state).toBe('unknown');
      expect(r.calls).toEqual([]);
    }
  });

  it('a URL on the configured site is read from the configured base, https only', () => {
    const r = recorder();
    const lookup = jiraTracker({ run: r.run, projects: ['CORE'], env: ENV });
    expect(lookup(ref('https://acme.atlassian.net')).state).toBe('resolved');
    expect(r.calls).toHaveLength(1);
    const [call] = r.calls;
    expect(call.args.at(-1)).toBe(
      'https://acme.atlassian.net/rest/api/2/issue/CORE-7?fields=status,resolution,assignee,summary',
    );
    expect(call.args).toEqual(expect.arrayContaining(['--proto', '=https']));
    expect(call.args.join(' ')).not.toContain('not-a-real-token');
    expect(call.input).toContain('not-a-real-token');
  });

  it('a URL-derived site is never trusted on its own: no configured base abstains', () => {
    const r = recorder();
    const { CANARY_JIRA_BASE_URL: _omit, ...noBase } = ENV;
    const lookup = jiraTracker({ run: r.run, projects: ['CORE'], env: noBase });
    expect(lookup(ref('https://acme.atlassian.net')).why).toMatch(
      /CANARY_JIRA_BASE_URL/,
    );
    expect(r.calls).toEqual([]);
  });

  it('a configured base that is not https abstains rather than send in cleartext', () => {
    const r = recorder();
    const lookup = jiraTracker({
      run: r.run,
      projects: ['CORE'],
      env: { ...ENV, CANARY_JIRA_BASE_URL: 'http://jira.example.com' },
    });
    expect(lookup(ref(null)).why).toMatch(/https/);
    expect(r.calls).toEqual([]);
  });

  it('credentials carrying a line break abstain (they would inject curl config)', () => {
    const r = recorder();
    const lookup = jiraTracker({
      run: r.run,
      projects: ['CORE'],
      env: { ...ENV, CANARY_JIRA_API_TOKEN: 'tok\nurl = "https://x.example"' },
    });
    expect(lookup(ref(null)).state).toBe('unknown');
    expect(r.calls).toEqual([]);
  });
});

// --- a closed issue is only "fixed" when it was closed as fixed ---------------

describe('closed is not the same as fixed', () => {
  const tracker = (issue: object, comments: string[] = []) =>
    githubTracker({
      run: (_cmd: string, args: string[]) =>
        args.some((a) => a.endsWith('/comments'))
          ? ok(comments.map((body) => JSON.stringify({ body })).join('\n'))
          : ok(issue),
      defaultRepo: 'acme/x',
    });
  const ask = (issue: object, comments: string[] = []) =>
    tracker(
      issue,
      comments,
    )({
      tracker: 'github',
      repo: null,
      number: 9,
      id: '#9',
    });
  const closed = (extra: object) => ({
    state: 'closed',
    title: 't',
    body: '',
    ...extra,
  });

  it('closed as not planned, with no hand-off, abstains', () => {
    const a = ask(closed({ state_reason: 'not_planned' }));
    expect(a.state).toBe('unknown');
    expect(a.why).toMatch(/not.planned/);
  });

  it('closed as a duplicate, with no hand-off, abstains', () => {
    expect(ask(closed({ state_reason: 'duplicate' })).state).toBe('unknown');
  });

  it('an unrecognised close reason abstains', () => {
    expect(ask(closed({ state_reason: 'something_new' })).state).toBe(
      'unknown',
    );
  });

  it('a pull request closed without merging abstains', () => {
    const a = ask(
      closed({ state_reason: null, pull_request: { merged_at: null } }),
    );
    expect(a.state).toBe('unknown');
    expect(a.why).toMatch(/without merging/);
  });

  it('not planned but handed off follows the hand-off instead', () => {
    const a = ask(closed({ state_reason: 'not_planned' }), [
      'Filed as acme/up#3',
    ]);
    expect(a.state).toBe('resolved');
    expect(a.handoff.map((r: any) => r.id)).toEqual(['acme/up#3']);
  });

  it('closed as completed, or a merged pull request, is resolved', () => {
    expect(ask(closed({ state_reason: 'completed' })).state).toBe('resolved');
    expect(
      ask(
        closed({
          state_reason: null,
          pull_request: { merged_at: '2026-10-01T00:00:00Z' },
        }),
      ).state,
    ).toBe('resolved');
  });
});

// --- every marker is accounted for, or reported -------------------------------

describe('unledgered markers are never hidden by a shorter title', () => {
  const SPEC = [
    "test.skip('login', () => {});",
    "test.skip('login retries forever', () => {});",
    '',
  ].join('\n');

  it('a row titled "login" does not hide test.skip("login retries forever")', () => {
    const repo = suite({ 'tests/a.spec.js': SPEC });
    const result = audit({
      repo,
      rows: [row('login', 'tests/a.spec.js', 'test.skip')],
      lookup: {},
    });
    expect(result.unledgered.map((m: any) => m.test)).toEqual([
      'login retries forever',
    ]);
  });

  it('a row with an empty title matches nothing and hides nothing', () => {
    const repo = suite({ 'tests/a.spec.js': SPEC });
    const result = audit({
      repo,
      rows: [row('', 'tests/a.spec.js', 'test.skip')],
      lookup: {},
    });
    expect(result.rows[0].class).toBe('stale');
    expect(result.unledgered.map((m: any) => m.test)).toEqual([
      'login',
      'login retries forever',
    ]);
  });
});

// --- a marker in a comment is not a marker -----------------------------------

describe('runtime skips are read from code, not comments', () => {
  it('a commented-out test.skip(cond) is no longer in force', () => {
    const repo = suite({
      'tests/a.spec.js': [
        "test('checkout', async () => {",
        "  // test.skip(process.env.CI, 'blocked by #12');",
        '  /* test.skip(true) */',
        '  expect(1).toBe(1);',
        '});',
        '',
      ].join('\n'),
    });
    const loc = locate(
      readSource(repo, 'tests/a.spec.js'),
      row('checkout', 'tests/a.spec.js', 'test.skip(condition)'),
    );
    expect(loc.found).toBe(true);
    expect(loc.marked).toBe(false);
  });

  it('a commented-out pytest.skip(...) in a python body is not in force', () => {
    const repo = suite({
      'tests/test_a.py': [
        'def test_checkout():',
        '    # pytest.skip("blocked by #12")',
        '    assert True',
        '',
      ].join('\n'),
    });
    const loc = locate(
      readSource(repo, 'tests/test_a.py'),
      row('test_checkout', 'tests/test_a.py', 'pytest.skip(condition)'),
    );
    expect(loc.marked).toBe(false);
  });
});

// --- pytest decorators that span lines ---------------------------------------

describe('multi-line pytest decorators', () => {
  const SRC = [
    'import pytest',
    '',
    '@pytest.mark.skipif(',
    '    sys.platform == "win32",',
    '    reason="blocked by #12 (windows)",',
    ')',
    'def test_paths():',
    '    assert True',
    '',
  ].join('\n');

  it('a skipif whose arguments span lines still skips the test', () => {
    const [decl] = pyDeclarations(SRC);
    expect(decl.decorators).toHaveLength(1);
    expect(decl.decorators[0]).toMatch(/^pytest\.mark\.skipif\(/);
    expect(decl.markerLine).toBe(3);
  });

  it('locate reads the row as still marked', () => {
    const repo = suite({ 'tests/test_p.py': SRC });
    const loc = locate(
      readSource(repo, 'tests/test_p.py'),
      row('test_paths', 'tests/test_p.py', 'pytest.mark.skipif'),
    );
    expect(loc.marked).toBe(true);
    expect(loc.markerLine).toBe(3);
  });

  it('a multi-line non-skip decorator above a skip does not hide it', () => {
    const src = [
      '@pytest.mark.parametrize(',
      '    "n", [1, 2]',
      ')',
      '@pytest.mark.skip(reason="blocked by #12")',
      'def test_n(n):',
      '    pass',
      '',
    ].join('\n');
    const [decl] = pyDeclarations(src);
    expect(decl.decorators).toEqual([
      'pytest.mark.skip(reason="blocked by #12")',
    ]);
    expect(decl.markerLine).toBe(1);
  });
});

// --- the hand-off chain limit is what the docs say ---------------------------

describe('hand-off chain boundary', () => {
  const gh = (n: number) => ({
    tracker: 'github',
    repo: 'a/b',
    number: n,
    id: `a/b#${n}`,
  });
  /** Issue 1 hands off to 2, ... up to `last`, which is simply closed. */
  const chain = (last: number) => ({
    github: (r: any) =>
      r.number < last
        ? { state: 'resolved', handoff: [gh(r.number + 1)] }
        : { state: 'resolved', handoff: [] },
  });
  const HOPS = MAX_HANDOFF_DEPTH - 1;

  it(`follows ${HOPS} hops to a resolved leaf`, () => {
    const [leaf] = resolveRef(gh(1), chain(1 + HOPS), {});
    expect(leaf.state).toBe('resolved');
    expect(leaf.via).toHaveLength(HOPS + 1);
  });

  it(`abstains on hop ${HOPS + 1}`, () => {
    const [leaf] = resolveRef(gh(1), chain(2 + HOPS), {});
    expect(leaf.state).toBe('unknown');
    expect(leaf.why).toMatch(new RegExp(`more than ${HOPS} hops`));
  });

  it('SKILL.md states the same limit', () => {
    const skill = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'claude-code',
        'canary-unquarantine',
        'SKILL.md',
      ),
      'utf8',
    );
    expect(skill).toMatch(new RegExp(`up to ${HOPS} hops`));
  });
});

// --- a trial only releases a test that proved itself (#1457) -----------------

describe('a retry pass is not a pass', () => {
  const xml = (child: string) =>
    `<testsuite><testcase classname="tests.a" name="t" file="tests/a.py">${child}</testcase></testsuite>`;

  it.each([
    ['surefire flakyFailure', '<flakyFailure message="x"/>'],
    ['surefire flakyError', '<flakyError message="x"></flakyError>'],
    ['pytest-rerunfailures rerun', '<rerun message="x"/>'],
  ])('%s reads as flaky, never pass', (_name, child) => {
    expect(junitCases(xml(child))[0].outcome).toBe('flaky');
  });

  it('a rerun that never passed is still a fail', () => {
    expect(
      junitCases(xml('<rerunFailure/><failure message="x"/>'))[0].outcome,
    ).toBe('fail');
  });
});

describe('the trial lifts the marker shapes the audit now reads, or refuses', () => {
  const lift = (lines: string[], markerLine: number, marker = 'x') =>
    planLift(lines, { markerLine, marker, test: 't' }, ['@known-failure']);

  it('lifts @mark.skip and @unittest.skip', () => {
    for (const deco of ['@mark.skip(reason="#4")', '@unittest.skip("#5")']) {
      const lines = [deco, 'def test_t():', '    pass'];
      const plan = lift(lines, 1) as any;
      expect(plan.edits).toBeDefined();
      expect(applyEdits(lines, plan.edits)).toEqual([
        'def test_t():',
        '    pass',
      ]);
    }
  });

  it('removes every line of a skipif whose arguments wrap, leaving valid source', () => {
    const lines = [
      '@pytest.mark.skipif(',
      '    sys.platform == "win32",',
      '    reason="blocked by #12",',
      ')',
      'def test_p():',
      '    pass',
    ];
    const plan = lift(lines, 1) as any;
    expect(applyEdits(lines, plan.edits)).toEqual([
      'def test_p():',
      '    pass',
    ]);
  });

  it('refuses a method skipped only through its class', () => {
    const lines = [
      '@pytest.mark.skip(reason="#3")',
      'class TestC:',
      '    def test_c(self):',
      '        pass',
    ];
    expect(lift(lines, 3)).toMatchObject({
      why: expect.stringMatching(/class/),
    });
  });

  it('refuses a tag in a Playwright details object rather than leave an empty tag', () => {
    const lines = [
      "test('t', { tag: ['@slow', '@known-failure'] }, async () => {});",
    ];
    expect(lift(lines, 1)).toMatchObject({
      why: expect.stringMatching(/details object/),
    });
  });

  it('lifts it.skipIf(cond)(...) to it(...)', () => {
    const lines = ["it.skipIf(process.env.CI)('t', () => {});"];
    const plan = lift(lines, 1) as any;
    expect(applyEdits(lines, plan.edits)).toEqual(["it('t', () => {});"]);
  });
});

describe('a test missing from the run is never judged on a sibling', () => {
  const FILE = 'tests/cart.spec.ts';
  const cases = (outcome: string) => [
    { file: FILE, titlePath: ['cart', 'adds item twice'], outcome },
  ];

  it('a passing sibling whose title contains the lifted one is missing, not pass', () => {
    expect(judge({ test: 'adds item', file: FILE }, cases('pass'))).toEqual({
      outcome: 'missing',
      cases: 0,
    });
  });

  it('containment may still keep a test quarantined: a failing match demotes', () => {
    expect(
      judge({ test: 'adds item', file: FILE }, cases('fail')).outcome,
    ).toBe('fail');
  });

  it('an exact segment still passes', () => {
    expect(
      judge({ test: 'adds item twice', file: FILE }, cases('pass')),
    ).toEqual({ outcome: 'pass', cases: 1 });
  });
});

describe('the Jira commenter sends credentials only to the configured site', () => {
  const ENV = {
    CANARY_JIRA_EMAIL: 'qa@example.com',
    CANARY_JIRA_API_TOKEN: 'not-a-real-token',
    CANARY_JIRA_BASE_URL: 'https://acme.atlassian.net',
  };
  const recorder = () => {
    const calls: Call[] = [];
    const run = (
      cmd: string,
      args: string[],
      opts: { input?: string } = {},
    ) => {
      calls.push({ cmd, args, input: opts.input });
      return ok('{}');
    };
    return { run, calls };
  };
  const ref = (base: string | null) => ({
    tracker: 'jira',
    key: 'CORE-7',
    project: 'CORE',
    base,
    id: 'CORE-7',
  });

  it('a ticket linked on a foreign host gets no comment and no credentials', () => {
    const r = recorder();
    const comment = jiraCommenter({ run: r.run, projects: ['CORE'], env: ENV });
    const out = comment(ref('https://attacker.example'), 'released');
    expect(out.ok).toBe(false);
    expect(out.why).toMatch(/not the configured Jira site/);
    expect(r.calls).toEqual([]);
  });

  it('posts to the configured site over https, credentials on stdin only', () => {
    const r = recorder();
    const comment = jiraCommenter({ run: r.run, projects: ['CORE'], env: ENV });
    expect(comment(ref(null), 'say "hi"').ok).toBe(true);
    const [call] = r.calls;
    expect(call.args.at(-1)).toBe(
      'https://acme.atlassian.net/rest/api/2/issue/CORE-7/comment',
    );
    expect(call.args).toEqual(expect.arrayContaining(['--proto', '=https']));
    expect(call.args.join(' ')).not.toContain('not-a-real-token');
    expect(call.input).toContain('not-a-real-token');
    expect(call.input).toContain(
      `data = ${JSON.stringify(JSON.stringify({ body: 'say "hi"' }))}`,
    );
  });
});

// --- second review of #1456: the reviewer's probe cases ----------------------

/** A GitHub tracker over `issues`: number -> {issue, comments}. */
function ghOver(
  issues: Record<
    number,
    { issue: object; comments: { body: string; author_association?: string }[] }
  >,
) {
  return githubTracker({
    defaultRepo: 'o/r',
    run: (_cmd: string, args: string[]) => {
      const m = /issues\/(\d+)(\/comments)?$/.exec(
        args.find((a) => a.startsWith('repos/'))!,
      )!;
      const it = issues[Number(m[1])];
      if (m[2]) return ok(it.comments.map((c) => JSON.stringify(c)).join('\n'));
      return ok(it.issue);
    },
  });
}
const closedDone = {
  state: 'closed',
  state_reason: 'completed',
  title: 't',
  body: '',
};
const ids = (refs: { id: string }[]) => refs.map((r) => r.id);
const handed = (...bodies: string[]) =>
  handoffRefs(
    { body: '', comments: bodies.map((body) => ({ body })) },
    { self: '#5' },
  );

describe('a hand-off line is never read as "no hand-off"', () => {
  it.each([
    ['Moved upstream to VEND-42.', ['VEND-42']],
    ['Moved upstream to VEND-42; closing here.', ['VEND-42']],
    ['Raised with the vendor: VEND-42', ['VEND-42']],
    ['Filed upstream:\nVEND-42', ['VEND-42']],
    ['Filed as VEND-42', ['VEND-42']],
  ])('%j names its bare key', (body, want) => {
    expect(ids(handed(body))).toEqual(want);
  });

  it('a hand-off to a target the audit cannot read is an unreadable ref, not none', () => {
    const refs = handed('Moved to https://gitlab.com/x/y/-/issues/3');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ tracker: 'unreadable' });
  });

  it('a closed-completed issue handed off to an unreadable target abstains', () => {
    const lookup = {
      github: ghOver({
        5: {
          issue: closedDone,
          comments: [{ body: 'Moved to https://gitlab.com/x/y/-/issues/3' }],
        },
      }),
    };
    const [leaf] = resolveRef(
      { tracker: 'github', repo: null, number: 5, id: '#5' },
      lookup,
      {},
    );
    expect(leaf.state).toBe('unknown');
    expect(leaf.why).toMatch(
      /hand-off line names a target this audit cannot read/,
    );
  });

  it('end to end: closed-completed but moved upstream to an unconfigured Jira key is not a candidate', () => {
    const repo = suite({
      'tests/a.spec.js':
        "// Quarantined against #5\ntest.skip('checkout', async () => {});\n",
    });
    const result = audit({
      repo,
      rows: [row('checkout', 'tests/a.spec.js', 'test.skip')],
      lookup: {
        github: ghOver({
          5: {
            issue: closedDone,
            comments: [{ body: 'Moved upstream to VEND-42; closing here.' }],
          },
        }),
        jira: jiraTracker({ run: () => ok('{}'), projects: [] }),
      },
    });
    expect(result.rows[0].class).toBe('abstain');
  });
});

describe('Jira done is only resolved when the resolution is a fix', () => {
  const ENV = {
    CANARY_JIRA_EMAIL: 'qa@example.com',
    CANARY_JIRA_API_TOKEN: 'not-a-real-token',
    CANARY_JIRA_BASE_URL: 'https://jira.example.com',
  };
  /** A done ticket with `resolution`, as Jira answers it. */
  const doneAs = (resolution: string | null) =>
    ok({
      fields: {
        status: { statusCategory: { key: 'done' } },
        resolution: resolution === null ? null : { name: resolution },
        summary: 's',
      },
    });
  const ask = (resolution: string | null, fixedResolutions?: string[]) => {
    const calls: string[][] = [];
    const run = (_c: string, args: string[]) => {
      calls.push(args);
      return doneAs(resolution);
    };
    const lookup = jiraTracker({
      run,
      projects: ['UP'],
      env: ENV,
      fixedResolutions,
    });
    const answer = lookup({
      tracker: 'jira',
      key: 'UP-1',
      project: 'UP',
      base: null,
      id: 'UP-1',
    });
    return { answer, calls };
  };

  it.each(["Won't Do", "Won't Fix", 'Duplicate', 'Cannot Reproduce'])(
    'done as %j abstains',
    (name) => {
      const { answer } = ask(name);
      expect(answer.state).toBe('unknown');
      expect(answer.why).toMatch(/not a fix/);
    },
  );

  it('done with no resolution abstains', () => {
    expect(ask(null).answer.state).toBe('unknown');
  });

  it('Done and Fixed are resolved, and the resolution is asked for', () => {
    expect(ask('Done').answer.state).toBe('resolved');
    const { answer, calls } = ask('fixed');
    expect(answer.state).toBe('resolved');
    expect(calls[0].at(-1)).toMatch(/fields=[^&]*resolution/);
  });

  it('the fixed list is configurable', () => {
    expect(ask('Released', ['Released']).answer.state).toBe('resolved');
    expect(ask('Done', ['Released']).answer.state).toBe('unknown');
  });
});

describe('an unreadable comment never reads as an empty one', () => {
  it('a comment line that is not JSON abstains the lookup', () => {
    const lookup = githubTracker({
      defaultRepo: 'o/r',
      run: (_c: string, args: string[]) =>
        args.includes('--paginate') ? ok('not-json\n') : ok(closedDone),
    });
    const a = lookup(
      { tracker: 'github', repo: null, number: 5, id: '#5' },
      {},
    );
    expect(a.state).toBe('unknown');
    expect(a.why).toMatch(/comment/);
  });
});

describe('every trusted hand-off counts; untrusted commenters do not re-route', () => {
  it('a later hand-off-like comment does not erase an earlier filing', () => {
    expect(
      ids(
        handed(
          'Filed as **UP-1**; stays quarantined.',
          'Follow-up docs tweak in #30.',
        ),
      ).sort(),
    ).toEqual(['#30', 'UP-1']);
  });

  it('a hand-off from an outside commenter is ignored', () => {
    const refs = handoffRefs(
      {
        body: '',
        comments: [
          { body: 'Filed as acme/up#3', author_association: 'MEMBER' },
          { body: 'Moved to acme/done#9', author_association: 'NONE' },
          { body: 'Moved to acme/x#10', author_association: 'CONTRIBUTOR' },
          {
            body: 'Moved to acme/x#11',
            author_association: 'FIRST_TIME_CONTRIBUTOR',
          },
        ],
      },
      { self: '#5' },
    );
    expect(ids(refs)).toEqual(['acme/up#3']);
  });

  it('the GitHub adapter asks for each comment author association', () => {
    const calls: string[][] = [];
    githubTracker({
      defaultRepo: 'o/r',
      run: (_c: string, args: string[]) => {
        calls.push(args);
        return args.includes('--paginate') ? ok('') : ok(closedDone);
      },
    })({ tracker: 'github', repo: null, number: 5, id: '#5' }, {});
    expect(calls.find((a) => a.includes('--paginate'))!.join(' ')).toMatch(
      /author_association/,
    );
  });
});

describe('every anchored blocker in the first sentence counts', () => {
  it('"against #12; also blocked by UP-7" waits on both', () => {
    expect(
      ids(pickBlocker('Quarantined against #12; also blocked by UP-7').refs),
    ).toEqual(['#12', 'UP-7']);
  });

  it('a later sentence does not add blockers', () => {
    expect(
      ids(
        pickBlocker('Quarantined against #12. Earlier it was blocked by #9.')
          .refs,
      ),
    ).toEqual(['#12']);
  });
});

describe('pytest skips the reader used to drop', () => {
  const SRC = [
    'import pytest',
    'import unittest',
    'from pytest import mark',
    '',
    '@pytest.mark.skip(reason="blocked by #1")',
    '# keep until #1 lands',
    'def test_a():',
    '    pass',
    '',
    '@pytest.mark.skip(reason="#2")',
    '',
    'def test_b():',
    '    pass',
    '',
    '@pytest.mark.skip(reason="#3")',
    'class TestC:',
    '    def test_c(self):',
    '        pass',
    '',
    '    def test_c2(self):',
    '        pass',
    '',
    'def test_after_class():',
    '    pass',
    '',
    '@mark.skip(reason="#4")',
    'def test_d():',
    '    pass',
    '',
    '@unittest.skip("#5")',
    'def test_e():',
    '    pass',
    '',
  ].join('\n');

  it('reads every skip, however it is spelled or separated', () => {
    expect(
      pyDeclarations(SRC).map((d) => [d.title, d.decorators.length]),
    ).toEqual([
      ['test_a', 1],
      ['test_b', 1],
      ['test_c', 1],
      ['test_c2', 1],
      ['test_after_class', 0],
      ['test_d', 1],
      ['test_e', 1],
    ]);
  });

  it('a module-level pytestmark skip abstains rather than read as released', () => {
    const repo = suite({
      'tests/test_m.py': [
        'import pytest',
        'pytestmark = pytest.mark.skip(reason="blocked by #1")',
        '',
        'def test_m():',
        '    pass',
        '',
      ].join('\n'),
    });
    const result = audit({
      repo,
      rows: [row('test_m', 'tests/test_m.py', 'pytest.mark.skip')],
      lookup: {},
      scan: false,
    });
    expect(result.rows[0].class).toBe('abstain');
    expect(result.rows[0].why).toMatch(/pytestmark/);
  });
});

describe('Playwright details tags and vitest skipIf are markers', () => {
  const SPEC = [
    "test('checkout total', { tag: '@known-failure' }, async () => {});",
    "test('two tags', { tag: ['@slow', '@quarantine'] }, async () => {});",
    "test('untagged details', { annotation: { type: 'x' } }, async () => {});",
    "it.skipIf(process.env.CI)('vitest skipIf', () => {});",
    "describe.runIf(false)('vitest runIf', () => {});",
    '',
  ].join('\n');

  it('declarations carry their details tags and conditional-skip callees', () => {
    const decls = jsDeclarations(maskJs(SPEC));
    expect(decls.map((d: any) => [d.callee, d.title])).toEqual([
      ['test', 'checkout total'],
      ['test', 'two tags'],
      ['test', 'untagged details'],
      ['it.skipIf', 'vitest skipIf'],
      ['describe.runIf', 'vitest runIf'],
    ]);
    expect(decls[0].tags).toEqual(['@known-failure']);
    expect(decls[1].tags).toEqual(['@slow', '@quarantine']);
  });

  it('the scan lists them as markers', () => {
    const repo = suite({ 'tests/a.spec.ts': SPEC });
    expect(scanSuite(repo).markers.map((m: any) => [m.test, m.marker])).toEqual(
      [
        ['checkout total', '@known-failure'],
        ['two tags', '@quarantine'],
        ['vitest skipIf', 'it.skipIf'],
        ['vitest runIf', 'describe.runIf'],
      ],
    );
  });
});

describe('nits that read as clear or reach outside the repo', () => {
  it('an unmarked exact title does not let its row hide a look-alike skip', () => {
    const repo = suite({
      'tests/a.spec.js': [
        "test('login', async () => {});",
        '// skipped for a different reason, no row',
        "test.skip('login retries forever', async () => {});",
      ].join('\n'),
    });
    const result = audit({
      repo,
      rows: [{ ...row('login', 'tests/a.spec.js', 'test.skip'), issue: '#9' }],
      lookup: {
        github: () => ({ state: 'resolved', title: '', url: '', handoff: [] }),
      },
    });
    expect(result.rows[0].class).toBe('stale');
    expect(result.unledgered.map((m: any) => m.test)).toEqual([
      'login retries forever',
    ]);
    expect(result.verdict.status).toBe('action');
  });

  it('a --repo with no test files abstains, even when every row is a removal', () => {
    const repo = suite({ 'README.md': 'not a suite\n' });
    const result = audit({
      repo,
      rows: [{ ...row('gone', 'tests/a.spec.js', 'x'), kind: 'removed' }],
      lookup: {},
    });
    expect(result.verdict.status).toBe('abstained');
    expect(result.verdict.reason).toMatch(/no test files/);
  });

  it('a ledger file path outside the repo is never read', () => {
    const outside = suite({ 'x.spec.js': "test.skip('t', () => {});\n" });
    const repo = suite({ 'tests/a.spec.js': '' });
    const rel = path.relative(repo, path.join(outside, 'x.spec.js'));
    expect(readSource(repo, rel)).toBeNull();
    expect(readSource(repo, path.join(outside, 'x.spec.js'))).toBeNull();
  });
});
