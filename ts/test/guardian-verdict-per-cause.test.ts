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

describe('case E: no source files changed', () => {
  it('#658 three JSON manifests: ✅, exit 0, each file a non-source skip', async () => {
    const res = await invokeGuardian(['pr-check', '--diff', '-'], {
      input: DIFF_658,
      cwd: tmp,
    });
    expect(res.code).toBe(0);
    expect(headline(res.stdout)).toBe(`${HEAD}\u{2705} ${E_HEADLINE}`);
    expect(res.stdout).not.toContain('matched 0');

    const data = await invokeGuardianJson(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_658, cwd: tmp },
    );
    expect((data['coverage'] as CoverageInputState).unitsTotal).toBe(0);
    const skipped = data['skipped'] as Array<{ name: string; reason: string }>;
    expect(skipped.filter((s) => s.reason === 'non-source')).toHaveLength(3);
  });

  it('#720 workflow + test: the sticky comment headlines ✅ E', async () => {
    const fake = new FakeGitHubClient();
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--post-comment'],
      {
        input: DIFF_720,
        env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    const sticky = fake.comments.find((c) => c.body.includes(STICKY_MARKER))!;
    expect(headline(sticky.body)).toBe(`${HEAD}\u{2705} ${E_HEADLINE}`);
    expect(sticky.body).not.toContain('\u{26A0}');
  });

  it('a docs/tests-only diff still abstains: the floor dropped nothing', async () => {
    const testOnly = DIFF_720.slice(DIFF_720.indexOf('diff --git a/ts/test'));
    const res = await invokeGuardian(['pr-check', '--diff', '-'], {
      input: testOnly,
      cwd: tmp,
    });
    expect(res.code).toBe(3);
  });
});
