// canary-unquarantine: a GitHub note that `gh issue comment` failed to post is
// printed in full (#1614), like every other note nobody posted. A second
// `--apply` cannot list it again, so the report is its only copy.

import { describe, it, expect } from 'vitest';

import { commentFailures } from '../claude-code/canary-unquarantine/scripts/notify.mjs';
import {
  renderVerdict,
  verdictDoc,
} from '../claude-code/canary-unquarantine/scripts/report.mjs';

const PR_URL = 'https://github.com/acme/orders-suite/pull/77';

const failing = {
  test: 'adds an item',
  file: 'tests/cart.spec.js',
  outcome: 'fail',
  cases: 1,
  blockers: [{ id: 'acme/orders-suite#505', tracker: 'github' }],
  trustedTarget: { id: 'acme/orders-suite#505', tracker: 'github' },
};

/** The `run` seam with `gh issue comment` failing, as on a 403 or an outage. */
const ghCommentFails = (cmd: string, args: string[]) =>
  cmd === 'gh' && args[0] === 'issue' && args[1] === 'comment'
    ? { status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible\n' }
    : { status: 0, stdout: '', stderr: '' };

const settle = () =>
  commentFailures({
    run: ghCommentFails,
    repo: '.',
    judged: [failing],
    prUrl: PR_URL,
  });

describe('a gh issue comment that failed', () => {
  it('keeps the note body on the failure, with gh error as the reason', () => {
    const [note] = settle();
    expect(note).toMatchObject({
      test: 'adds an item',
      target: 'acme/orders-suite#505',
      commented: false,
      why: 'HTTP 403: Resource not accessible',
    });
    expect(note.body).toMatch(/^canary-unquarantine trial: `adds an item`/);
    expect(note.body).toContain(PR_URL);
  });

  it('prints the whole note under its NOT told line in the plain report', () => {
    const comments = settle();
    const doc = verdictDoc(
      { pr: 77, apply: true },
      { judged: [failing], documents: 1, cases: 1 },
      comments,
    );
    const lines = renderVerdict(doc).split('\n');
    const at = lines.indexOf(
      '  NOT told acme/orders-suite#505: HTTP 403: Resource not accessible',
    );
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(`      ${comments[0].body}`);
    expect(lines[at + 1]).toMatch(/still fails/);
    expect(lines[at + 1]).toContain(PR_URL);
  });

  it('a posted note still carries no body, so the report prints none', () => {
    const [note] = commentFailures({
      run: () => ({ status: 0, stdout: '', stderr: '' }),
      repo: '.',
      judged: [failing],
      prUrl: PR_URL,
    });
    expect(note).toEqual({
      test: 'adds an item',
      target: 'acme/orders-suite#505',
      commented: true,
      why: '',
    });
  });
});
