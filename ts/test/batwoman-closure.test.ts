/**
 * Resolving an issue number to the change that closed it (spec Phase 4).
 *
 * This is the second half of batwoman's network surface, and it carries the
 * same rule as the first: never answer a question it failed to ask. An issue
 * with no merged closing PR, an unreachable `gh`, and output that will not
 * parse all throw, because a fabricated empty changed-file set would render as
 * a clean report over a denominator of zero -- a pass over nothing, presented
 * as a pass.
 *
 * Every test injects a fake `SubprocessRun`; the suite never shells out.
 */
import { describe, expect, it } from 'vitest';
import type {
  SubprocessResult,
  SubprocessRun,
} from '../src/core/workflow-discovery.js';
import { resolveClosure } from '../src/analysis/batwoman/closure.js';

function ok(stdout: string): SubprocessResult {
  return { returncode: 0, stdout, stderr: '' };
}

/** Replies per command, keyed by a substring of the argv. */
function fakeGh(
  routes: Array<[string, SubprocessResult]>,
): SubprocessRun & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((cmd: string[]) => {
    calls.push(cmd);
    const joined = cmd.join(' ');
    for (const [needle, reply] of routes) {
      if (joined.includes(needle)) return reply;
    }
    return { returncode: 1, stdout: '', stderr: `unrouted: ${joined}` };
  }) as SubprocessRun & { calls: string[][] };
  run.calls = calls;
  return run;
}

/** #749's real shape: closed by #751, seven files, two of them added. */
const ISSUE_749 = ok(
  JSON.stringify({
    number: 749,
    closedByPullRequestsReferences: [{ number: 751 }],
  }),
);

const PR_751 = ok(
  JSON.stringify({
    number: 751,
    mergedAt: '2026-08-23T18:34:04Z',
    mergeCommit: { oid: '1e0c05b20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    title: 'fix(ci): make the refresh-baseline label refresh the baseline',
  }),
);

/**
 * As the live endpoint actually answers: `--paginate --slurp` wraps rows in an
 * array of PAGES. The first version of this fixture was a flat list, which is
 * what the code was written against and is not what gh returns.
 */
const FILES_751 = ok(
  JSON.stringify([
    [
      {
        status: 'modified',
        filename: '.github/workflows/refresh-arch-baseline.yml',
      },
      { status: 'modified', filename: 'AGENTS.md' },
      { status: 'added', filename: 'scripts/refresh-arch-baseline.mjs' },
      { status: 'removed', filename: 'scripts/old-refresher.mjs' },
    ],
  ]),
);

const HAPPY: Array<[string, SubprocessResult]> = [
  ['issue view', ISSUE_749],
  ['pr view', PR_751],
  ['/files', FILES_751],
];

describe('resolveClosure', () => {
  it("reads #749's real closure into a header and a changed-file set", async () => {
    const closure = await resolveClosure(
      749,
      'bop-clocktower/canary',
      fakeGh(HAPPY),
    );

    expect(closure.header.issue).toBe(749);
    expect(closure.header.mergeSha).toBe(
      '1e0c05b20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(closure.header.mergeSubject).toContain('refresh-baseline label');
    expect(closure.header.mergedAt.toISOString()).toBe(
      '2026-08-23T18:34:04.000Z',
    );
    expect(closure.files).toHaveLength(4);
  });

  it('takes the deletion set from status, not from an empty additions count', async () => {
    // `additions: 0` cannot mean deleted -- a file gutted to nothing looks
    // identical. Only `status: "removed"` says the file is gone.
    const closure = await resolveClosure(749, 'r/r', fakeGh(HAPPY));

    expect([...closure.deleted]).toEqual(['scripts/old-refresher.mjs']);
    // A deleted path is still a changed file: it belongs in the denominator,
    // reported as not-applicable rather than dropped out of the count.
    expect(closure.files).toContain('scripts/old-refresher.mjs');
  });

  it('throws when the issue has no closing pull request', async () => {
    // Reporting zero changed files would render as a clean run over a
    // denominator of nothing -- the precise false green batwoman detects.
    const gh = fakeGh([
      [
        'issue view',
        ok(JSON.stringify({ number: 5, closedByPullRequestsReferences: [] })),
      ],
    ]);

    await expect(resolveClosure(5, 'r/r', gh)).rejects.toThrow(
      /no closing pull request/i,
    );
  });

  it('throws when the closing pull request was never merged', async () => {
    const gh = fakeGh([
      ['issue view', ISSUE_749],
      [
        'pr view',
        ok(
          JSON.stringify({
            number: 751,
            mergedAt: null,
            mergeCommit: null,
            title: 't',
          }),
        ),
      ],
    ]);

    await expect(resolveClosure(749, 'r/r', gh)).rejects.toThrow(/not merged/i);
  });

  it('picks the most recently merged PR when several closed the issue', async () => {
    // GitHub allows more than one. Picking arbitrarily would make the report
    // depend on array order; the latest merge is the one whose code stands.
    const gh = fakeGh([
      [
        'issue view',
        ok(
          JSON.stringify({
            number: 749,
            closedByPullRequestsReferences: [{ number: 700 }, { number: 751 }],
          }),
        ),
      ],
      [
        'pr view --repo r/r 700',
        ok(
          JSON.stringify({
            number: 700,
            mergedAt: '2026-01-01T00:00:00Z',
            mergeCommit: { oid: 'aaa' },
            title: 'older',
          }),
        ),
      ],
      ['pr view --repo r/r 751', PR_751],
      ['/files', FILES_751],
    ]);

    const closure = await resolveClosure(749, 'r/r', gh);

    expect(closure.header.mergeSubject).toContain('refresh-baseline label');
    expect(closure.pullRequest).toBe(751);
  });

  it('throws when gh fails, rather than reporting an empty change set', async () => {
    const gh = fakeGh([
      [
        'issue view',
        { returncode: 1, stdout: '', stderr: 'gh: not authenticated' },
      ],
    ]);

    await expect(resolveClosure(749, 'r/r', gh)).rejects.toThrow(
      /not authenticated/,
    );
  });

  it('throws on unparseable output rather than reading it as no files', async () => {
    const gh = fakeGh([['issue view', ok('<html>rate limited</html>')]]);

    await expect(resolveClosure(749, 'r/r', gh)).rejects.toThrow();
  });

  it('accepts a flat row list as well as a paged one', async () => {
    // Defence, not speculation: the shape gh returns is a flag-combination
    // detail, and pinning the code to exactly one of them is what broke the
    // first live run.
    const gh = fakeGh([
      ['issue view', ISSUE_749],
      ['pr view', PR_751],
      [
        '/files',
        ok(
          JSON.stringify([
            { status: 'modified', filename: 'a.yml' },
            { status: 'removed', filename: 'b.mjs' },
          ]),
        ),
      ],
    ]);

    const closure = await resolveClosure(749, 'r/r', gh);

    expect(closure.files).toEqual(['a.yml', 'b.mjs']);
    expect([...closure.deleted]).toEqual(['b.mjs']);
  });

  it('never combines --slurp with --jq, which gh rejects', async () => {
    // The live #749 run failed on exactly this: `gh api --slurp --jq` exits 1
    // with "the --slurp option is not supported with --jq or --template". A
    // fixture cannot catch it, so the argv is asserted directly.
    const gh = fakeGh(HAPPY);
    await resolveClosure(749, 'r/r', gh);

    const filesCall = gh.calls.find((c) => c.join(' ').includes('/files'));
    expect(filesCall).toBeDefined();
    expect(filesCall).toContain('--slurp');
    expect(filesCall).not.toContain('--jq');
  });

  it('throws when the closing PR reports no changed files at all', async () => {
    // An empty file list is not a legitimate answer: a merged PR changed
    // something. Rendering it would produce "0 of 0 files" and read as clean.
    const gh = fakeGh([
      ['issue view', ISSUE_749],
      ['pr view', PR_751],
      ['/files', ok('[]')],
    ]);

    await expect(resolveClosure(749, 'r/r', gh)).rejects.toThrow(
      /no changed files/i,
    );
  });
});
