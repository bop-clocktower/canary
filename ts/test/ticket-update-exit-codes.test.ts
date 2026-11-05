/**
 * #1413: `ticket-update` reported failed or impossible actions as success.
 *
 * These drive the REAL `TicketUpdater` through the real CLI, with only the HTTP
 * and subprocess seams faked. A faked `UpdateResult` would only prove the exit
 * decision reads a shape the test invented; several of these paths are about
 * what the updater actually returns (an unreachable target reported as
 * attempted, a credential failure indistinguishable from a failed POST).
 *
 * Exit contract: 0 = done or legitimately nothing to do, 1 = an action failed
 * or would fail, 3 = abstained, nothing could be reached at all.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCanaryCommand } from '../src/cli.js';
import { TicketUpdater } from '../src/core/ticket-updater.js';
import type {
  HttpClient,
  SubprocessRun,
} from '../src/core/workflow-discovery.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const CREDS = {
  ATLASSIAN_URL: 'https://jira.example.test',
  ATLASSIAN_USER: 'user',
  ATLASSIAN_TOKEN: 'token',
};

interface JiraBehaviour {
  commentOk?: boolean;
  statusOk?: boolean;
  /** Status names the ticket can move to from where it is now. */
  reachable?: string[];
  transitionOk?: boolean;
}

/** A fake Jira behind the `http` seam; records every call it receives. */
function fakeJira(behaviour: JiraBehaviour = {}): {
  http: HttpClient;
  calls: string[];
} {
  const {
    commentOk = true,
    statusOk = true,
    reachable = ['QA Passed'],
    transitionOk = true,
  } = behaviour;
  const calls: string[] = [];
  const respond = (ok: boolean, body: unknown = {}) => ({
    ok,
    status: ok ? 200 : 500,
    text: JSON.stringify(body),
  });
  const http = (async (req: { url: string; method?: string }) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url.endsWith('/comment')) return respond(commentOk);
    if (req.url.includes('?fields=status')) {
      return respond(statusOk, { fields: { status: { name: 'In QA' } } });
    }
    if (req.method === 'GET') {
      return respond(true, {
        transitions: reachable.map((name, i) => ({
          id: String(i),
          to: { name },
        })),
      });
    }
    return respond(transitionOk);
  }) as unknown as HttpClient;
  return { http, calls };
}

let tmp: string;
let canaryDir: string;
let passReport: string;

function writeMapping(project: string, atlassianUrl?: string): void {
  writeFileSync(
    join(canaryDir, `workflow-${project}.json`),
    JSON.stringify({
      project_key: project,
      source: 'jira',
      discovered_at: '2026-01-01T00:00:00+00:00',
      issue_types: [],
      semantic_roles: {
        qa_passed: { status_name: 'QA Passed', issue_type: 'Story' },
      },
      role_annotations_confirmed: true,
      ...(atlassianUrl ? { atlassian_url: atlassianUrl } : {}),
    }),
    'utf-8',
  );
}

function run(
  args: string[],
  opts: {
    http?: HttpClient;
    subprocess?: SubprocessRun;
    env?: Record<string, string>;
  } = {},
) {
  const { http = fakeJira().http, subprocess, env = CREDS } = opts;
  return invokeCanary(['ticket-update', '--ticket', 'PROJ-1', ...args], {
    env,
    deps: {
      makeTicketUpdater: () =>
        new TicketUpdater(canaryDir, {
          http,
          ...(subprocess ? { subprocess } : {}),
        }),
    },
  });
}

beforeEach(() => {
  tmp = mkTmp();
  canaryDir = join(tmp, '.canary');
  mkdirSync(canaryDir, { recursive: true });
  passReport = join(tmp, 'report.json');
  writeFileSync(passReport, JSON.stringify({ result: 'pass' }), 'utf-8');
  writeMapping('PROJ');
});

afterEach(() => {
  rmTmp(tmp);
});

describe('#1413 path 1: a comment that was not posted is a failure', () => {
  it('exits 1 and says so when Jira rejects the comment', async () => {
    const res = await run([], { http: fakeJira({ commentOk: false }).http });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Comment not posted to PROJ-1');
    expect(res.stdout).not.toContain('Comment posted');
  });

  it('exits 1 when the gh comment fails', async () => {
    const subprocess = (() => ({
      returncode: 1,
      stdout: '',
      stderr: 'boom',
    })) as unknown as SubprocessRun;
    const res = await invokeCanary(
      ['ticket-update', '--ticket', '#12', '--project', 'o/r'],
      {
        deps: {
          makeTicketUpdater: () => new TicketUpdater(canaryDir, { subprocess }),
        },
      },
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Comment not posted to #12');
  });

  it('exits 1 when a comment fails even though the transition landed', async () => {
    const res = await run(['--result', passReport], {
      http: fakeJira({ commentOk: false }).http,
    });
    expect(res.stdout).toContain('Transitioned PROJ-1');
    expect(res.code).toBe(1);
  });

  it('does not count a comment --transition-only never tried to post', async () => {
    const { http, calls } = fakeJira({ commentOk: false });
    const res = await run(['--transition-only', '--result', passReport], {
      http,
    });
    expect(calls.some((c) => c.endsWith('/comment'))).toBe(false);
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain('Comment not posted');
  });
});

describe('#1413 path 2: missing credentials abstain', () => {
  // Every flag combination here reaches Jira zero times, so "verified zero
  // items" is literally true of all of them, dry run included: a dry run
  // promising an action the real run cannot take is the same false green.
  it.each([
    ['a comment, FAIL result', [], false],
    ['--comment-only', ['--comment-only'], false],
    ['--transition-only on PASS', ['--transition-only', 'PASS'], false],
    ['comment and transition on PASS', ['PASS'], false],
    ['--dry-run on PASS', ['--dry-run', 'PASS'], true],
    ['--dry-run --comment-only', ['--dry-run', '--comment-only'], true],
  ])('exits 3 for %s', async (_name, flags, dryRun) => {
    const args = flags.flatMap((f) =>
      f === 'PASS' ? ['--result', passReport] : [f],
    );
    const { http, calls } = fakeJira();
    const res = await run(args, { http, env: {} });
    expect(res.code).toBe(3);
    expect(calls).toEqual([]);
    expect(res.stdout).toContain('Abstained');
    expect(res.stdout).toContain('ATLASSIAN_TOKEN');
    expect(res.stdout).not.toContain('Comment posted');
    expect(res.stdout).not.toContain('Would transition');
    expect(res.stdout.includes('Would post comment')).toBe(dryRun);
  });

  it('exits 1, not 3, when the comment landed but the transition has no credentials', async () => {
    // Abstaining would say nothing happened, and a comment did: the ticket
    // changed, so a caller must not read this as a clean no-op to retry. The
    // comment resolves PROJ's stored URL, the transition OTHER's absent one.
    writeMapping('PROJ', 'https://jira.example.test');
    writeMapping('OTHER');
    const res = await run(['--project', 'OTHER', '--result', passReport], {
      env: { ATLASSIAN_USER: 'user', ATLASSIAN_TOKEN: 'token' },
    });
    expect(res.stdout).toContain('Comment posted to PROJ-1');
    expect(res.stdout).toContain('credentials not configured');
    expect(res.code).toBe(1);
  });

  it('a real failure outranks the abstention', async () => {
    // No mapping is the #1283 WARN failure and stays exit 1. Its message used
    // to claim "Comment was posted." unconditionally, which is false here.
    const res = await run(['--project', 'UNMAPPED', '--result', passReport], {
      env: {},
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('No workflow mapping found');
    expect(res.stdout).not.toContain('Comment was posted');
  });
});

describe('#1413: credentials on one side only excuse that side', () => {
  // `--project` can name a different project from the ticket's prefix, and the
  // stored URL is per project, so the comment and the transition can resolve
  // different credentials. Exit 3 says "verified zero items", which is only
  // true when neither action got anywhere.
  const USER_AND_TOKEN = { ATLASSIAN_USER: 'user', ATLASSIAN_TOKEN: 'token' };
  const FLAGS = () => ['--project', 'OTHER', '--result', passReport];
  const posts = (calls: string[], suffix: string) =>
    calls.filter((c) => c.startsWith('POST ') && c.endsWith(suffix));

  it('cell A: exits 1, not 3, after the transition really moved the ticket', async () => {
    writeMapping('OTHER', 'https://other.example.test');
    const { http, calls } = fakeJira();
    const res = await run(FLAGS(), { http, env: USER_AND_TOKEN });
    expect(posts(calls, '/transitions')).toHaveLength(1);
    expect(res.stdout).toContain('Transitioned PROJ-1');
    expect(res.stderr).toContain('Comment not posted to PROJ-1');
    expect(res.stdout).not.toContain('Abstained');
    expect(res.code).toBe(1);
  });

  it('cell B: exits 1, not 3, when Jira rejected the comment and only the transition lacks credentials', async () => {
    writeMapping('PROJ', 'https://jira.example.test');
    writeMapping('OTHER');
    const { http, calls } = fakeJira({ commentOk: false });
    const res = await run(FLAGS(), { http, env: USER_AND_TOKEN });
    expect(posts(calls, '/comment')).toHaveLength(1);
    expect(res.stderr).toContain('Comment not posted to PROJ-1');
    expect(res.stdout).not.toContain('Abstained');
    expect(res.code).toBe(1);
  });

  it('cell C: exits 1, not 3, when gh failed and only the transition lacks credentials', async () => {
    const subprocess = (() => ({
      returncode: 1,
      stdout: '',
      stderr: 'boom',
    })) as unknown as SubprocessRun;
    const res = await run(
      ['--ticket', '#12', '--project', 'PROJ', '--result', passReport],
      { subprocess, env: {} },
    );
    expect(res.stderr).toContain('Comment not posted to #12');
    expect(res.stdout).not.toContain('Abstained');
    expect(res.code).toBe(1);
  });

  // A dry run predicts the real run, so it must exit as the real run would.
  it('a dry run of the comment-lands, no-transition-credentials cell exits 1 like the live run', async () => {
    writeMapping('PROJ', 'https://jira.example.test');
    writeMapping('OTHER');
    const { http, calls } = fakeJira();
    const res = await run([...FLAGS(), '--dry-run'], {
      http,
      env: USER_AND_TOKEN,
    });
    expect(calls).toEqual([]);
    expect(res.stdout).toContain('Would post comment');
    expect(res.stdout).not.toContain('Abstained');
    expect(res.code).toBe(1);
  });

  it('a dry run of cell A exits 1 like the live run', async () => {
    writeMapping('OTHER', 'https://other.example.test');
    const { http, calls } = fakeJira();
    const res = await run([...FLAGS(), '--dry-run'], {
      http,
      env: USER_AND_TOKEN,
    });
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true);
    expect(res.stdout).toContain('Would transition');
    expect(res.stdout).not.toContain('Abstained');
    expect(res.code).toBe(1);
  });

  it('a dry run of a GitHub comment with no transition credentials exits 1 like a live run whose comment lands', async () => {
    const subprocess = (() => ({
      returncode: 0,
      stdout: '',
      stderr: '',
    })) as unknown as SubprocessRun;
    const args = ['--ticket', '#12', '--project', 'PROJ'];
    const live = await run([...args, '--result', passReport], {
      subprocess,
      env: {},
    });
    const dry = await run([...args, '--result', passReport, '--dry-run'], {
      subprocess,
      env: {},
    });
    expect(live.code).toBe(1);
    expect(dry.code).toBe(1);
  });

  // Every combination of what each side can resolve and how Jira answers,
  // against a contract stated independently of the implementation. The cells
  // above are the ones that escaped; this is what stops the next one.
  describe('the exit contract across every combination', () => {
    const SECRET = { ATLASSIAN_USER: 'sekrit-u', ATLASSIAN_TOKEN: 'sekrit-t' };
    const bools = [true, false];
    const modes = [
      { name: 'both', flags: [] as string[], comment: true, transition: true },
      {
        name: '--comment-only',
        flags: ['--comment-only'],
        comment: true,
        transition: false,
      },
      {
        name: '--transition-only',
        flags: ['--transition-only'],
        comment: false,
        transition: true,
      },
    ];
    const cells = modes.flatMap((mode) =>
      [false, true].flatMap((dryRun) =>
        bools.flatMap((commentUrl) =>
          bools.flatMap((transitionUrl) =>
            bools.flatMap((commentOk) =>
              bools.map((transitionOk) => ({
                mode,
                dryRun,
                commentUrl,
                transitionUrl,
                commentOk,
                transitionOk,
              })),
            ),
          ),
        ),
      ),
    );
    type Cell = (typeof cells)[number];

    /** 1 if anything failed or some but not all could run, 3 if none could. */
    function expectedExit(c: Cell): number {
      const asked = [
        { wanted: c.mode.comment, url: c.commentUrl, ok: c.commentOk },
        { wanted: c.mode.transition, url: c.transitionUrl, ok: c.transitionOk },
      ].filter((action) => action.wanted);
      const runnable = asked.filter((action) => action.url);
      // A dry run posts nothing, so Jira cannot reject anything in one.
      if (!c.dryRun && runnable.some((action) => !action.ok)) return 1;
      if (runnable.length === asked.length) return 0;
      return runnable.length > 0 ? 1 : 3;
    }

    it('exercises every exit code, so the sweep below is not vacuous', () => {
      expect(cells).toHaveLength(96);
      const codes = new Set(cells.map(expectedExit));
      expect([...codes].sort()).toEqual([0, 1, 3]);
    });

    it.each(cells.map((c) => [describeCell(c), c] as const))(
      '%s',
      async (_name, c) => {
        writeMapping(
          'PROJ',
          c.commentUrl ? 'https://p.example.test' : undefined,
        );
        writeMapping(
          'OTHER',
          c.transitionUrl ? 'https://o.example.test' : undefined,
        );
        const { http, calls } = fakeJira({
          commentOk: c.commentOk,
          transitionOk: c.transitionOk,
        });
        const res = await run(
          [...FLAGS(), ...c.mode.flags, ...(c.dryRun ? ['--dry-run'] : [])],
          { http, env: SECRET },
        );
        expect(res.code).toBe(expectedExit(c));
        // The docblock's and the PR's claim: exit 3 reached Jira zero times.
        if (res.code === 3) {
          expect(calls).toEqual([]);
          expect(res.stdout).toContain('Abstained');
        } else {
          expect(res.stdout).not.toContain('Abstained');
        }
        if (c.dryRun) {
          expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
        }
        // Messages name the env vars, never their values.
        const printed = res.stdout + res.stderr;
        expect(printed).not.toContain('sekrit');
      },
    );

    function describeCell(c: Cell): string {
      return [
        c.mode.name,
        c.dryRun ? 'dry' : 'live',
        `comment ${c.commentUrl ? 'url' : 'no-url'}/${c.commentOk ? 'ok' : '500'}`,
        `transition ${c.transitionUrl ? 'url' : 'no-url'}/${c.transitionOk ? 'ok' : '500'}`,
      ].join(', ');
    }
  });
});

describe('#1413 paths 3 and 6: a dry run must not bless an impossible transition', () => {
  it('exits 1 and does not print "Would transition" for an unreachable target', async () => {
    const res = await run(['--dry-run', '--result', passReport], {
      http: fakeJira({ reachable: ['Blocked'] }).http,
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('not reachable');
    expect(res.stdout).not.toContain('Would transition');
  });

  it('still exits 0 and writes nothing for a reachable target', async () => {
    const { http, calls } = fakeJira();
    const res = await run(['--dry-run', '--result', passReport], { http });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Would transition');
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true);
  });
});

describe('#1413 path 5: an unfetchable current status is a failure', () => {
  it.each([
    ['live', []],
    ['--dry-run', ['--dry-run']],
  ])('exits 1 (%s)', async (_name, flags) => {
    const res = await run([...flags, '--result', passReport], {
      http: fakeJira({ statusOk: false }).http,
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Could not fetch current status for PROJ-1');
    expect(res.stdout).not.toContain('Would transition');
    expect(res.stdout).not.toContain('Transitioned');
  });
});

describe('#1413 path 4: help describes only what exists', () => {
  it('stops promising auto-detect and last-run defaults', async () => {
    const command = createCanaryCommand().commands.find(
      (c) => c.name() === 'ticket-update',
    );
    const help = command!.helpInformation().replace(/\s+/g, ' ');
    // Guard the guard: an empty capture would pass the negatives below.
    expect(help).toContain('--test-file');
    expect(help).toContain('--result');
    // `--project` and `--ticket` really do override an auto-detected value, so
    // this matches the promised default rather than the word.
    expect(help).not.toContain('default: auto-detect');
    expect(help).not.toContain('last run');
    expect(help).toContain('the run counts as FAIL');
  });

  it('without --result the run counts as FAIL, as the help now says', async () => {
    const { http, calls } = fakeJira();
    const res = await run([], { http });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Run result is FAIL');
    expect(calls.filter((c) => c.endsWith('/transitions'))).toEqual([]);
  });

  it("without --test-file linkage comes from the report's test_file, as the help now says", async () => {
    const testFile = join(tmp, 'linked.spec.ts');
    writeFileSync(testFile, '# canary:ticket: PROJ-9\n', 'utf-8');
    writeFileSync(passReport, JSON.stringify({ test_file: testFile }), 'utf-8');
    const res = await invokeCanary(['ticket-update', '--result', passReport], {
      env: CREDS,
      deps: {
        makeTicketUpdater: () =>
          new TicketUpdater(canaryDir, { http: fakeJira().http }),
      },
    });
    expect(res.stdout).toContain('Comment posted to PROJ-9');
    expect(res.code).toBe(0);
  });
});

describe('#1413: outcomes that are legitimately exit 0', () => {
  it('a full success', async () => {
    const res = await run(['--result', passReport]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Comment posted to PROJ-1');
    expect(res.stdout).toContain('Transitioned PROJ-1');
    expect(res.stderr).toBe('');
  });

  it('--comment-only with a posted comment', async () => {
    const res = await run(['--comment-only']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Comment posted to PROJ-1');
  });
});
