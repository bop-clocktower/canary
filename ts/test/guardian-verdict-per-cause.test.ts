/**
 * #928 — one honest headline per cause.
 *
 * Guardian used to give a single "no gaps found, but coverage was unavailable"
 * warning to five different situations. Each case below is pinned from the
 * real PR shape the #928 audit found it on:
 *
 *   A  only non-executable lines changed in an instrumented file (#927, #841)
 *   B  source outside every instrumented tree (#925)
 *   C  coverable lines the report does not contain (a genuinely stale report)
 *   E  no source files at all: config/data plus tests (#658, #720)
 *
 * Worst first: C > B > A/E. A PR with any B or C unit is never ✅ (#554).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChangedUnit,
  CoverageInputState,
  coverageDegradedNotice,
  resolveCoverageWithInput,
} from '../src/guardian/coverage.js';
import { renderFindings } from '../src/guardian/pr-check.js';
import { FakeGitHubClient, STICKY_MARKER } from '../src/guardian/pr-comment.js';
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

/** Write an lcov whose records are `{path: [lines measured]}`, all hit. */
function lcov(records: Record<string, number[]>): string {
  const body = Object.entries(records)
    .map(
      ([p, lines]) =>
        `SF:${p}\n${lines.map((l) => `DA:${l},1`).join('\n')}\nend_of_record\n`,
    )
    .join('');
  const path = join(tmp, 'lcov.info');
  writeFileSync(path, body, 'utf-8');
  return path;
}

function resolve(units: ChangedUnit[], report: string): CoverageInputState {
  return resolveCoverageWithInput(units, {
    coveragePath: report,
    graphPath: join(tmp, 'missing-graph.json'),
    repoRoot: tmp,
  }).coverage;
}

const comment = (coverage: CoverageInputState): string =>
  renderFindings([], 'comment', 0, null, {
    checked: coverage.unitsTotal,
    abstained: false,
    coverage,
  });

const text = (coverage: CoverageInputState): string =>
  renderFindings([], 'text', 0, null, {
    checked: coverage.unitsTotal,
    abstained: false,
    coverage,
  });

const headline = (body: string): string =>
  body.split('\n').find((l) => l.startsWith('## '))!;

const HEAD = '## \u{1F424} Canary PR Guardian \u{2014} ';

// #927: a three-line doc-comment edit. lcov measures the function body around
// it, never the comment lines themselves.
const DOC_COMMENT_UNIT: ChangedUnit = {
  path: 'ts/src/guardian/diff-extractor.ts',
  added_ranges: [[122, 124]],
};
// #841: properties added inside a multi-line object literal. lcov records only
// the statement's first line (585), so the continuation lines are not coverable.
const CONTINUATION_UNIT: ChangedUnit = {
  path: 'ts/src/cli-commands.ts',
  added_ranges: [[591, 598]],
};
// #925: an agents/skills helper, outside the ts/src tree the report instruments.
const OUT_OF_TREE_UNIT: ChangedUnit = {
  path: 'agents/skills/lib/parse-args.mjs',
  added_ranges: [[1, 20]],
};

const REPORT = {
  'ts/src/guardian/diff-extractor.ts': [118, 130],
  'ts/src/cli-commands.ts': [585, 600],
};

describe('case A: non-coverable-only edits are recorded apart from absent ones', () => {
  it('#927 doc comment: counted non-coverable, not eligible, not stale', () => {
    const state = resolve([DOC_COMMENT_UNIT], lcov(REPORT));
    expect(state.unitsMatched).toBe(0);
    expect(state.unitsNonCoverable).toBe(1);
    expect(state.unitsEligible).toBe(0);
    expect(coverageDegradedNotice(state) ?? '').not.toContain('stale');
  });

  it('#927 renders ✅ nothing to test on both surfaces', () => {
    const state = resolve([DOC_COMMENT_UNIT], lcov(REPORT));
    expect(headline(comment(state))).toBe(
      `${HEAD}\u{2705} nothing to test: only non-executable lines changed (1 file)`,
    );
    expect(text(state).split('\n')[0]).toBe(
      'Canary PR Guardian \u{2014} nothing to test: only non-executable lines changed (1 file)',
    );
  });

  it('#841 object-literal continuation lines are case A too', () => {
    const state = resolve([CONTINUATION_UNIT, DOC_COMMENT_UNIT], lcov(REPORT));
    expect(state.unitsNonCoverable).toBe(2);
    expect(headline(comment(state))).toContain(
      'nothing to test: only non-executable lines changed (2 files)',
    );
    expect(comment(state)).not.toContain('coverage unavailable');
  });
});

describe('case B: outside every instrumented tree', () => {
  it('#925 agents/skills only: ⚠️ not coverage-checked, naming the tree', () => {
    const state = resolve([OUT_OF_TREE_UNIT], lcov(REPORT));
    const want =
      'not coverage-checked: 1 file outside instrumented trees (ts/src)';
    expect(headline(comment(state))).toBe(`${HEAD}\u{26A0}\u{FE0F} ${want}`);
    expect(text(state).split('\n')[0]).toBe(
      `Canary PR Guardian \u{2014} ${want}`,
    );
  });

  it('mixed A+B shows ⚠️ B with A as a count underneath, never ✅ (#554)', () => {
    const state = resolve([DOC_COMMENT_UNIT, OUT_OF_TREE_UNIT], lcov(REPORT));
    const body = comment(state);
    expect(headline(body)).toContain(
      'not coverage-checked: 1 file outside instrumented trees',
    );
    expect(headline(body)).not.toContain('\u{2705}');
    expect(body).toContain(
      '- 1 file: nothing to test (only non-executable lines changed)',
    );
    expect(text(state)).toContain(
      '- 1 file: nothing to test (only non-executable lines changed)',
    );
  });
});

describe('case C: a genuinely stale report', () => {
  it('a coverable line absent from the lcov renders ⚠️ stale', () => {
    const unit: ChangedUnit = {
      path: 'ts/src/brand-new.ts',
      added_ranges: [[1, 3]],
    };
    const state = resolve([unit, OUT_OF_TREE_UNIT], lcov(REPORT));
    expect(state.unitsEligible).toBe(1);
    const body = comment(state);
    // Worst first: C outranks the B unit, which becomes a count.
    expect(headline(body)).toBe(
      `${HEAD}\u{26A0}\u{FE0F} coverage report stale: 1 changed file missing from it`,
    );
    expect(body).toContain('- 1 file: not coverage-checked');
  });

  it('renders the degradation sentence once, not again in the footer', () => {
    const unit: ChangedUnit = {
      path: 'ts/src/brand-new.ts',
      added_ranges: [[1, 3]],
    };
    const state = resolve([unit], lcov(REPORT));
    const notice = coverageDegradedNotice(state)!;
    const body = comment(state);
    expect(body.split(notice).length - 1).toBe(1);
    expect(text(state).split(notice).length - 1).toBe(1);
  });
});

// #658: three JSON manifests (CHANGELOG/README are already skipGlobs).
const DIFF_658 = [
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  'npm/package.json',
]
  .map(
    (p) =>
      `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -3,1 +3,1 @@\n+  "version": "6.7.0",\n`,
  )
  .join('');

// #720: a workflow plus a test file.
const DIFF_720 =
  'diff --git a/.github/workflows/dogfood.yml b/.github/workflows/dogfood.yml\n' +
  '--- a/.github/workflows/dogfood.yml\n+++ b/.github/workflows/dogfood.yml\n' +
  '@@ -10,0 +11,1 @@\n+      - run: echo hi\n' +
  'diff --git a/ts/test/workflow-false-green.test.ts b/ts/test/workflow-false-green.test.ts\n' +
  '--- a/ts/test/workflow-false-green.test.ts\n+++ b/ts/test/workflow-false-green.test.ts\n' +
  "@@ -1,0 +2,1 @@\n+it('x', () => expect(1).toBe(1));\n";

const E_HEADLINE = 'nothing to test: no source files changed';

const DIFF_DOCS =
  'diff --git a/docs/guide.md b/docs/guide.md\n' +
  '--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1,0 +2,1 @@\n+More words.\n';
const DIFF_TESTS = DIFF_720.slice(DIFF_720.indexOf('diff --git a/ts/test'));
const DIFF_SOURCE =
  'diff --git a/pkg/widget.py b/pkg/widget.py\n' +
  '--- a/pkg/widget.py\n+++ b/pkg/widget.py\n' +
  '@@ -0,0 +1,2 @@\n+def widget():\n+    return 42\n';

/** Run pr-check with --post-comment against `fake`; returns the exit code. */
async function post(diff: string, fake: FakeGitHubClient): Promise<number> {
  const res = await invokeGuardian(
    ['pr-check', '--diff', '-', '--post-comment'],
    {
      input: diff,
      env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
      cwd: tmp,
      deps: { buildCommentClient: () => fake },
    },
  );
  return res.code;
}

const stickies = (fake: FakeGitHubClient) =>
  fake.comments.filter((c) => c.body.includes(STICKY_MARKER));

// ADR 0009: every "nothing to judge" run abstains (exit 3), and still posts
// the ✅ E sticky so an earlier ⚠️ one can never linger.
describe('case E: no source files changed', () => {
  it('#658 three JSON manifests: exit 3, each file a non-source skip', async () => {
    const data = await invokeGuardianJson(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_658, cwd: tmp },
    );
    expect(data['abstained']).toBe(true);
    const skipped = data['skipped'] as Array<{ name: string; reason: string }>;
    expect(skipped.filter((s) => s.reason === 'non-source')).toHaveLength(3);
  });

  it.each([
    ['config-only (#658)', DIFF_658],
    ['workflow + test (#720)', DIFF_720],
    ['docs-only', DIFF_DOCS],
    ['tests-only', DIFF_TESTS],
  ])('%s: exit 3 and a posted ✅ E sticky', async (_name, diff) => {
    const fake = new FakeGitHubClient();
    expect(await post(diff, fake)).toBe(3);
    const [sticky] = stickies(fake);
    expect(headline(sticky!.body)).toBe(`${HEAD}\u{2705} ${E_HEADLINE}`);
    expect(sticky!.body).not.toContain('\u{26A0}');
  });

  it('a ⚠️ sticky from an earlier push is updated, not duplicated', async () => {
    const fake = new FakeGitHubClient();
    await post(DIFF_SOURCE, fake);
    expect(headline(stickies(fake)[0]!.body)).toContain('\u{26A0}');
    expect(await post(DIFF_658, fake)).toBe(3);
    expect(stickies(fake)).toHaveLength(1);
    expect(headline(stickies(fake)[0]!.body)).toBe(
      `${HEAD}\u{2705} ${E_HEADLINE}`,
    );
  });

  it('a heuristic-only no-coverage abstention keeps its own headline (#761)', async () => {
    const fake = new FakeGitHubClient();
    expect(await post(DIFF_SOURCE, fake)).toBe(3);
    const line = headline(stickies(fake)[0]!.body);
    expect(line).toContain('abstained: no coverage data');
    expect(line).not.toContain(E_HEADLINE);
  });
});
