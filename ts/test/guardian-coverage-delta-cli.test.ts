/**
 * #606 — `pr-check --base-coverage` at the CLI seam.
 *
 * Two behaviors are load-bearing and pinned here:
 *
 *  1. A regression against a real base artifact becomes a finding.
 *  2. **No base artifact is an abstention, not a pass.** The run degrades to
 *     "delta unavailable — head-only" LOUDLY (annotation + step summary + the
 *     json denominator), because most CI never uploads a base-branch coverage
 *     artifact and a silent head-only run would read as "no regressions".
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => rmTmp(tmp));

const DIFF = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -1,2 +1,4 @@
+def widget():
+    return 42
+
`;

function lcov(name: string, hits: Record<number, number>): string {
  const path = join(tmp, name);
  const body = Object.entries(hits).map(([l, h]) => `DA:${l},${h}`);
  writeFileSync(
    path,
    `SF:pkg/widget.py\n${body.join('\n')}\nend_of_record\n`,
    'utf-8',
  );
  return path;
}

describe('pr-check --base-coverage (#606)', () => {
  it('reports a coverage regression on a touched unit', async () => {
    const base = lcov('base.info', { 1: 1, 2: 1, 3: 1, 4: 1 });
    const head = lcov('head.info', { 1: 1, 2: 0, 3: 0, 4: 0 });

    const res = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        '-',
        '--coverage',
        head,
        '--base-coverage',
        base,
        '--format',
        'json',
      ],
      { input: DIFF, cwd: tmp },
    );

    const payload = JSON.parse(res.stdout);
    expect(payload.coverage_delta.status).toBe('compared');
    expect(payload.coverage_delta.unitsCompared).toBe(1);
    const kinds = payload.findings.map((f: { kind: string }) => f.kind);
    expect(kinds).toContain('coverage-regression');
  });

  it('emits no regression finding when coverage held steady', async () => {
    const base = lcov('base.info', { 1: 1, 2: 0 });
    const head = lcov('head.info', { 1: 1, 2: 0 });

    const res = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        '-',
        '--coverage',
        head,
        '--base-coverage',
        base,
        '--format',
        'json',
      ],
      { input: DIFF, cwd: tmp },
    );

    const payload = JSON.parse(res.stdout);
    expect(payload.coverage_delta.status).toBe('compared');
    const kinds = payload.findings.map((f: { kind: string }) => f.kind);
    expect(kinds).not.toContain('coverage-regression');
  });

  it('degrades LOUDLY to head-only when no base artifact was supplied', async () => {
    const head = lcov('head.info', { 1: 1, 2: 0 });
    const summary = join(tmp, 'summary.md');

    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--coverage', head, '--format', 'json'],
      {
        input: DIFF,
        cwd: tmp,
        env: { GITHUB_STEP_SUMMARY: summary },
      },
    );

    const payload = JSON.parse(res.stdout);
    // The denominator is present and states that nothing was compared — the
    // absence of regression findings is therefore never mistakable for a pass.
    expect(payload.coverage_delta.status).toBe('unavailable');
    expect(payload.coverage_delta.unitsCompared).toBe(0);
    expect(payload.coverage_delta.unitsTotal).toBeGreaterThan(0);

    // `--format json` owns stdout, so the annotation goes to stderr; CI scans
    // both streams for workflow commands.
    expect(res.stderr).toContain('::warning::');
    expect(res.stderr).toContain('coverage delta unavailable');
    expect(res.stderr).toContain('head-only');

    expect(readFileSync(summary, 'utf-8')).toContain(
      'coverage delta unavailable',
    );
  });

  it('names the missing base artifact rather than saying nothing', async () => {
    const head = lcov('head.info', { 1: 1 });
    const missing = join(tmp, 'no-such-base.info');

    const res = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        '-',
        '--coverage',
        head,
        '--base-coverage',
        missing,
        '--format',
        'json',
      ],
      { input: DIFF, cwd: tmp },
    );

    const payload = JSON.parse(res.stdout);
    expect(payload.coverage_delta.baseFound).toBe(false);
    expect(payload.coverage_delta.baseRequested).toBe(missing);
    expect(res.stderr).toContain(missing);
  });
});
