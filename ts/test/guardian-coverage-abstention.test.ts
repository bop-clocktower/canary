/**
 * #761 — a `pr-check` run that resolved NO coverage abstains; it must not
 * headline a finding count.
 *
 * Guardian already exits 3 when the diff carried no findings-eligible units.
 * That is the wrong denominator: a run can have plenty of eligible units and
 * still have verified nothing, because "findings-eligible" and
 * "coverage-verifiable" are different counts. The gap is the middle row here:
 *
 *   | run shape                     | eligible | coverage denom | honest answer |
 *   | normal PR, lcov present       |    N     |       N        | findings      |
 *   | code PR, no lcov on the runner|    N     |       0        | ABSTAIN       |
 *   | docs-only PR                  |    0     |       0        | ABSTAIN       |
 *
 * Callers commonly run guardian with `continue-on-error: true`, so the headline
 * IS the signal a human reads. "6 files need test coverage" on a run that
 * verified zero coverage is indistinguishable from a verified run — the exact
 * false-green shape exit 3 exists to prevent.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

// One findings-eligible source file: N > 0 eligible units, so the pre-existing
// zero-eligible-units abstention does NOT fire here.
const DIFF_SOURCE = `diff --git a/pkg/widget.py b/pkg/widget.py
new file mode 100644
--- /dev/null
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

// Docs only: zero findings-eligible units — the abstention that already worked.
const DIFF_DOCS_ONLY = `diff --git a/docs/guide.md b/docs/guide.md
--- a/docs/guide.md
+++ b/docs/guide.md
@@ -1,2 +1,3 @@
 # Guide
+A new sentence.
`;

const BLIND: CoverageInputState = {
  requested: null,
  found: false,
  parsed: false,
  filesInReport: 0,
  unitsMatched: 0,
  unitsTotal: 1,
};

function heuristicFinding(): GuardianFinding[] {
  return [
    new GuardianFinding({
      path: 'pkg/widget.py',
      unit: 'widget',
      fidelity: Fidelity.Heuristic,
      severity: Severity.MEDIUM,
      evidence: 'no covering test for widget',
    }),
  ];
}

describe('the abstention headline replaces the count (#761)', () => {
  it('comment surface headlines the abstention, keeping the findings', () => {
    const body = renderFindings(heuristicFinding(), 'comment', 0, null, {
      checked: 1,
      abstained: true,
      coverage: BLIND,
    });
    const headline = body.split('\n').find((l) => l.startsWith('## '))!;
    expect(headline).toContain('abstained');
    expect(headline).not.toContain('needs test coverage');
    // The heuristic findings are still useful; they are just not a verdict.
    expect(body).toContain('no covering test for widget');
    expect(body).toContain(STICKY_MARKER);
  });

  it('text surface headlines the abstention too', () => {
    const out = renderFindings(heuristicFinding(), 'text', 0, null, {
      checked: 1,
      abstained: true,
      coverage: BLIND,
    });
    expect(out.split('\n')[0]).toContain('abstained');
    expect(out.split('\n')[0]).not.toContain('file(s) need test coverage');
  });

  it('a verified run keeps the finding-count headline', () => {
    const body = renderFindings(heuristicFinding(), 'comment', 0, null, {
      checked: 1,
      abstained: false,
      coverage: {
        requested: '/x/lcov.info',
        found: true,
        parsed: true,
        filesInReport: 3,
        unitsMatched: 1,
        unitsTotal: 1,
      },
    });
    const headline = body.split('\n').find((l) => l.startsWith('## '))!;
    expect(headline).toContain('1 file needs test coverage');
    expect(headline).not.toContain('abstained');
  });
});

describe('pr-check abstains on a zero coverage denominator (#761)', () => {
  it('no lcov + eligible units + heuristic findings exits 3, not 0', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_SOURCE, cwd: tmp },
    );
    const payload = JSON.parse(res.stdout);
    // The precondition: this run HAD findings-eligible units, so the
    // pre-existing zero-eligible abstention is not what is being observed.
    expect(payload.checked).toBeGreaterThan(0);
    expect(payload.coverage.status).toBe('unavailable');
    expect(payload.abstained).toBe(true);
    expect(res.code).toBe(3);
  });

  it('lcov covering the diff leaves the run un-abstained', async () => {
    const lcov = join(tmp, 'lcov.info');
    writeFileSync(
      lcov,
      'SF:pkg/widget.py\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n',
      'utf-8',
    );
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--coverage', lcov, '--format', 'json'],
      { input: DIFF_SOURCE, cwd: tmp },
    );
    const payload = JSON.parse(res.stdout);
    expect(payload.coverage.status).toBe('verified');
    expect(payload.abstained).toBe(false);
    expect(res.code).not.toBe(3);
  });

  it('the docs-only zero-eligible abstention still exits 3', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_DOCS_ONLY, cwd: tmp },
    );
    expect(res.code).toBe(3);
  });

  it('the sticky comment abstains rather than reporting a count', async () => {
    const fake = new FakeGitHubClient();
    await invokeGuardian(['pr-check', '--diff', '-', '--post-comment'], {
      input: DIFF_SOURCE,
      env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
      cwd: tmp,
      deps: { buildCommentClient: () => fake },
    });
    const sticky = fake.comments.find((c) => c.body.includes(STICKY_MARKER))!;
    const headline = sticky.body.split('\n').find((l) => l.startsWith('## '))!;
    expect(headline).toContain('abstained');
  });

  it('the emitted analysis record carries the abstention', async () => {
    const analyses = join(tmp, 'analyses');
    const res = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        '-',
        '--emit-analysis',
        '--analyses-dir',
        analyses,
      ],
      {
        input: DIFF_SOURCE,
        env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
        cwd: tmp,
      },
    );
    expect(res.code).toBe(3);
    const record = JSON.parse(readEmitted(res.stdout));
    expect(record.abstained).toBe(true);
    expect(record.coverage.status).toBe('unavailable');
    // The findings survive into the record: they are evidence, just not a
    // coverage verdict.
    expect(record.findings.length).toBeGreaterThan(0);
  });
});

/** Read the analysis record the CLI reported writing. */
function readEmitted(stdout: string): string {
  const line = stdout
    .split('\n')
    .find((l) => l.includes('wrote analysis record'))!;
  const path = line.slice(line.lastIndexOf(' ') + 1);
  return readFileSync(path, 'utf-8');
}
