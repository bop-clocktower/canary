/**
 * #554 — the coverage-input state must reach the surfaces a human and a metric
 * actually read: the emitted analysis record, the sticky PR comment, and the
 * `--format json` local output.
 *
 * The measured failure this pins: 274/274 downstream runs emitted
 * `degradedNotice: null`, so "guardian reported no coverage findings" was
 * indistinguishable from "guardian never saw a coverage report". A clean-looking
 * short list must never be the whole story of a coverage-blind run.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SCHEMA_VERSION,
  buildAnalysisRecord,
} from '../src/guardian/analysis-emit.js';
import { CoverageInputState, Fidelity } from '../src/guardian/coverage.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import { GuardianFinding, renderFindings } from '../src/guardian/pr-check.js';
import { FakeGitHubClient, STICKY_MARKER } from '../src/guardian/pr-comment.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => rmTmp(tmp));

const DIFF_NEW_UNIT = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

const BLIND: CoverageInputState = {
  requested: null,
  found: false,
  parsed: false,
  filesInReport: 0,
  unitsMatched: 0,
  unitsTotal: 1,
};

const VERIFIED: CoverageInputState = {
  requested: '/x/lcov.info',
  found: true,
  parsed: true,
  filesInReport: 3,
  unitsMatched: 1,
  unitsTotal: 1,
};

function finding(): GuardianFinding[] {
  return [
    new GuardianFinding({
      path: 'pkg/a.py',
      unit: 'alpha',
      fidelity: Fidelity.Heuristic,
      severity: Severity.MEDIUM,
      evidence: 'no covering test for alpha',
    }),
  ];
}

describe('analysis record carries the coverage block (#554)', () => {
  it('schema version tracks the additive blocks (1.1 coverage, 1.2 skipped)', () => {
    // Pinned so a schema change can never be an accident. #554 added the
    // coverage block at 1.1; #582 added the skipped list at 1.2.
    expect(SCHEMA_VERSION).toBe('1.2');
  });

  it('coverage-blind run records its state, not null', () => {
    const record = buildAnalysisRecord([], {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
      coverage: BLIND,
    });
    expect(record.coverage).not.toBeNull();
    expect(record.coverage!.status).toBe('unavailable');
    expect(record.coverage!.unitsMatched).toBe(0);
    expect(record.coverage!.unitsTotal).toBe(1);
    // The prose field the six-week measurement found empty in 274/274 runs.
    expect(record.degradedNotice).toContain('coverage unavailable');
  });

  it('a verified run says so and adds no degradation prose', () => {
    const record = buildAnalysisRecord([], {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
      coverage: VERIFIED,
    });
    expect(record.coverage!.status).toBe('verified');
    expect(record.degradedNotice).toBeNull();
  });

  it('an existing tier notice is preserved alongside the coverage one', () => {
    const record = buildAnalysisRecord([], {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: 'tier 2 unavailable -- degraded to tier 0',
      exit_code: 0,
      coverage: BLIND,
    });
    expect(record.degradedNotice).toContain('tier 2 unavailable');
    expect(record.degradedNotice).toContain('coverage unavailable');
  });

  it('no coverage argument at all leaves the block null (non-pr-check producers)', () => {
    const record = buildAnalysisRecord([], {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(record.coverage).toBeNull();
  });
});

describe('sticky comment states the coverage mode (#554)', () => {
  it('zero findings + blind coverage does not render as a clean pass', () => {
    const body = renderFindings([], 'comment', 0, null, {
      checked: 1,
      abstained: false,
      coverage: BLIND,
    });
    expect(body).toContain(STICKY_MARKER);
    expect(body).toContain('coverage unavailable');
    // The headline must not read as a verified all-clear.
    const headline = body.split('\n').find((l) => l.startsWith('## '))!;
    expect(headline).not.toContain('no test-coverage gaps');
  });

  it('zero findings + verified coverage keeps the clean headline', () => {
    const body = renderFindings([], 'comment', 0, null, {
      checked: 1,
      abstained: false,
      coverage: VERIFIED,
    });
    const headline = body.split('\n').find((l) => l.startsWith('## '))!;
    expect(headline).toContain('no test-coverage gaps');
    expect(body).not.toContain('coverage unavailable');
  });

  it('findings present + blind coverage still states the mode', () => {
    const body = renderFindings(finding(), 'comment', 0, null, {
      checked: 1,
      abstained: false,
      coverage: BLIND,
    });
    expect(body).toContain('coverage unavailable');
  });

  it('json output carries the coverage block', () => {
    const payload = JSON.parse(
      renderFindings([], 'json', 0, null, {
        checked: 1,
        abstained: false,
        coverage: BLIND,
      }),
    );
    expect(payload.coverage.status).toBe('unavailable');
    expect(payload.degraded_notice).toContain('coverage unavailable');
  });
});

describe('pr-check end-to-end (#554)', () => {
  it('no --coverage: json output reports the blind run', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    const payload = JSON.parse(res.stdout);
    expect(payload.coverage.status).toBe('unavailable');
    expect(payload.coverage.requested).toBeNull();
    expect(payload.degraded_notice).toContain('coverage unavailable');
  });

  it('the ::warning:: annotation never lands in --format json stdout', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    // stdout must stay a parseable document; the annotation goes to stderr,
    // which CI scans for workflow commands just the same.
    expect(res.stdout).not.toContain('::warning::');
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stderr).toContain('::warning::');
    expect(res.stderr).toContain('coverage unavailable');
  });

  it('--post-comment keeps the annotation on stdout (CI log surface)', async () => {
    const fake = new FakeGitHubClient();
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--post-comment'],
      {
        input: DIFF_NEW_UNIT,
        env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.stdout).toContain('::warning::');
  });

  it('--coverage pointing at a missing file is reported, not swallowed', async () => {
    const missing = join(tmp, 'nope.info');
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--coverage', missing, '--format', 'json'],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    const payload = JSON.parse(res.stdout);
    expect(payload.coverage.found).toBe(false);
    expect(payload.degraded_notice).toContain('not found');
  });

  it('--coverage matching the diff reports a verified run', async () => {
    const lcov = join(tmp, 'lcov.info');
    writeFileSync(
      lcov,
      'SF:pkg/widget.py\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n',
      'utf-8',
    );
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--coverage', lcov, '--format', 'json'],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    const payload = JSON.parse(res.stdout);
    expect(payload.coverage.status).toBe('verified');
    expect(payload.degraded_notice).toBeUndefined();
  });

  it('posted sticky comment names the coverage mode', async () => {
    const fake = new FakeGitHubClient();
    await invokeGuardian(['pr-check', '--diff', '-', '--post-comment'], {
      input: DIFF_NEW_UNIT,
      env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
      cwd: tmp,
      deps: { buildCommentClient: () => fake },
    });
    const sticky = fake.comments.find((c) => c.body.includes(STICKY_MARKER))!;
    expect(sticky.body).toContain('coverage unavailable');
  });
});
