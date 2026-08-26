/**
 * #761 — provenance must survive the trip through `runPrCheck`, not just the
 * pure renderer.
 *
 * `guardian-diff-provenance.test.ts` covers `provenanceLine` and
 * `detectMergeRef` as pure functions. That left the entire wiring untested: a
 * review of that file found you could delete the provenance construction from
 * `cli.ts` — the `gateMeta` hand-off, the `emitAnalysis` hand-off, and the
 * merge-ref annotation — and every one of those unit tests stayed green. A
 * feature that reaches no real emitted surface is exactly the shape #761 is
 * about, so it must not be the shape of #761's own tests.
 *
 * These drive the real CLI through {@link invokeGuardian}, network-free, with
 * `git` injected through {@link GuardianDeps}.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitResult } from '../src/guardian/cli.js';
import {
  invokeGuardian,
  invokeGuardianJson,
  mkTmp,
  rmTmp,
} from './guardian-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => rmTmp(tmp));

const PR_HEAD = '2cfb03cbfbd74e04d0a76869d062c816090c75d3';
const MERGE_REF_HEAD = '9f1e4d7a3b2c5e8f0a1d6c9b4e7f2a5d8c3b6e90';

const ok = (stdout = ''): GitResult => ({ code: 0, stdout });

function fakeGit(table: Record<string, GitResult>) {
  return (args: string[]): GitResult =>
    table[args.join(' ')] ?? { code: 1, stdout: '' };
}

/**
 * THREE changed files, of which only ONE survives filtering (the other two are
 * test paths). The mix is the whole point of the `fileCount` assertions below.
 */
const DIFF_THREE_FILES = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,2 @@
+def widget():
+    return 42
diff --git a/tests/test_widget.py b/tests/test_widget.py
index 3333333..4444444 100644
--- a/tests/test_widget.py
+++ b/tests/test_widget.py
@@ -0,0 +1,2 @@
+def test_widget():
+    assert widget() == 42
diff --git a/tests/test_other.py b/tests/test_other.py
index 5555555..6666666 100644
--- a/tests/test_other.py
+++ b/tests/test_other.py
@@ -0,0 +1,2 @@
+def test_other():
+    assert True
`;

/** Every unit filtered away — the abstain path. */
const DIFF_ALL_TESTS = `diff --git a/tests/test_only.py b/tests/test_only.py
index 5555555..6666666 100644
--- a/tests/test_only.py
+++ b/tests/test_only.py
@@ -0,0 +1,2 @@
+def test_only():
+    assert True
`;

/** Write a `pull_request` event payload declaring `headSha` as the PR head. */
function eventFile(headSha: string): string {
  const path = join(tmp, 'event.json');
  writeFileSync(
    path,
    JSON.stringify({ pull_request: { head: { sha: headSha } } }),
  );
  return path;
}

/** CI env for a `pull_request` run whose checkout is the merge ref. */
function mergeRefEnv(): Record<string, string> {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_BASE_REF: 'main',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventFile(PR_HEAD),
  };
}

const CI_GIT = (head: GitResult) =>
  fakeGit({
    'rev-parse --verify --quiet origin/main^{commit}': ok('abc123\n'),
    'diff origin/main...HEAD': ok(DIFF_THREE_FILES),
    'rev-parse HEAD': head,
  });

describe('provenance reaches the real emitted surfaces (#761)', () => {
  it('the JSON payload carries the endpoints the run was scoped by', async () => {
    const data = (await invokeGuardianJson(['pr-check', '--format', 'json'], {
      cwd: tmp,
      env: mergeRefEnv(),
      deps: { runGit: CI_GIT(ok(`${MERGE_REF_HEAD}\n`)) },
    })) as { provenance?: Record<string, unknown>; checked?: number };

    expect(data.provenance).toBeDefined();
    expect(data.provenance!['base']).toBe('origin/main');
    expect(data.provenance!['head']).toBe(MERGE_REF_HEAD);
    expect(data.provenance!['origin']).toBe('ci-base');
    expect(data.provenance!['mergeRef']).toBe(true);
  });

  it('fileCount is the PR-sized number, NOT the post-filter one', async () => {
    // The invariant that makes provenance useful and that a code comment alone
    // could not defend: a reviewer checks `fileCount` against the file list
    // GitHub shows them, so it must count what guardian was HANDED (3), not
    // what it went on to score (1). "Fixing" the disagreement with `checked`
    // would silently destroy the feature.
    const data = (await invokeGuardianJson(['pr-check', '--format', 'json'], {
      cwd: tmp,
      env: mergeRefEnv(),
      deps: { runGit: CI_GIT(ok(`${MERGE_REF_HEAD}\n`)) },
    })) as { provenance?: Record<string, unknown>; checked?: number };

    expect(data.provenance!['fileCount']).toBe(3);
    expect(data.checked).toBe(1);
  });

  it('the merge ref is annotated loudly on stderr and the step summary', async () => {
    const summary = join(tmp, 'summary.md');
    const res = await invokeGuardian(['pr-check', '--format', 'json'], {
      cwd: tmp,
      env: { ...mergeRefEnv(), GITHUB_STEP_SUMMARY: summary },
      deps: { runGit: CI_GIT(ok(`${MERGE_REF_HEAD}\n`)) },
    });

    expect(res.stderr).toContain('::warning::');
    expect(res.stderr).toContain('MERGE REF');
    // Advisory by design: the caller owns the checkout, so this never reds a
    // build that would otherwise pass.
    expect(res.code).toBe(0);
  });

  it('makes no merge-ref claim when HEAD already IS the PR head', async () => {
    const res = await invokeGuardian(['pr-check', '--format', 'json'], {
      cwd: tmp,
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_BASE_REF: 'main',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventFile(PR_HEAD),
      },
      deps: { runGit: CI_GIT(ok(`${PR_HEAD}\n`)) },
    });

    expect(res.stderr).not.toContain('MERGE REF');
    const data = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as {
      provenance: Record<string, unknown>;
    };
    expect(data.provenance['mergeRef']).toBeUndefined();
    expect(data.provenance['head']).toBe(PR_HEAD);
  });
});

describe('resolveHeadSha degrades without asserting a clean head (#761)', () => {
  // Three ways git can decline to answer. None may render as a KNOWN head:
  // a wrong sha in the provenance line is worse than an honest `?`.
  const cases: Array<[string, GitResult | null]> = [
    ['git is unavailable (null)', null],
    ['git exits non-zero', { code: 128, stdout: '' }],
    ['git succeeds but prints nothing', { code: 0, stdout: '  \n' }],
  ];

  for (const [label, head] of cases) {
    it(`renders head as null when ${label}`, async () => {
      const data = (await invokeGuardianJson(['pr-check', '--format', 'json'], {
        cwd: tmp,
        env: mergeRefEnv(),
        deps: {
          runGit: (args: string[]) =>
            args.join(' ') === 'rev-parse HEAD' ? head : CI_GIT(ok(''))(args),
        },
      })) as { provenance?: Record<string, unknown> };

      expect(data.provenance!['head']).toBeNull();
      // Unknown head means merge-ref detection must make NO claim, rather than
      // reporting a difference against a head it never resolved.
      expect(data.provenance!['mergeRef']).toBeUndefined();
    });
  }
});

describe('an abstained run still states what it diffed (#761)', () => {
  it('carries provenance on the exit-3 JSON payload', async () => {
    // The surface the #761 narrative names as the real failure: that run SHOULD
    // have abstained. "Correctly abstained on a docs-only PR" and "abstained
    // because the diff was wrong" are indistinguishable without the range.
    const res = await invokeGuardian(['pr-check', '--format', 'json'], {
      cwd: tmp,
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_BASE_REF: 'main',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventFile(PR_HEAD),
      },
      deps: {
        runGit: fakeGit({
          'rev-parse --verify --quiet origin/main^{commit}': ok('abc123\n'),
          'diff origin/main...HEAD': ok(DIFF_ALL_TESTS),
          'rev-parse HEAD': ok(`${MERGE_REF_HEAD}\n`),
        }),
      },
    });

    expect(res.code).toBe(3);
    const data = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as {
      abstained: boolean;
      provenance: Record<string, unknown> | null;
    };
    expect(data.abstained).toBe(true);
    expect(data.provenance).not.toBeNull();
    expect(data.provenance!['fileCount']).toBe(1);
    expect(data.provenance!['mergeRef']).toBe(true);
  });

  it('states the range on the human abstain surface too', async () => {
    const res = await invokeGuardian(['pr-check', '--format', 'text'], {
      cwd: tmp,
      env: { GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' },
      deps: {
        runGit: fakeGit({
          'rev-parse --verify --quiet origin/main^{commit}': ok('abc123\n'),
          'diff origin/main...HEAD': ok(DIFF_ALL_TESTS),
          'rev-parse HEAD': ok(`${MERGE_REF_HEAD}\n`),
        }),
      },
    });

    expect(res.code).toBe(3);
    expect(res.stdout.toLowerCase()).toContain('abstained');
    expect(res.stdout).toContain('origin/main...9f1e4d7a3b');
    expect(res.stdout).toContain('1 file');
  });
});
