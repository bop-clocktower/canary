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
