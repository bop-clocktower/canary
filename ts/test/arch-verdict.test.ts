/**
 * Contract tests for `scripts/arch-verdict.mjs` and its wiring into
 * `scripts/harness-report-summary.mjs` (#626).
 *
 * Two harness commands read the same architecture data and reach opposite
 * verdicts. `harness check-arch` reports the **absolute** violation count and
 * exits 1; the ratchet inside `harness ci check` reports the **delta** and
 * passes when the delta is zero. On `main` that is `28 issues, exit 1` next to
 * `{"name":"arch","status":"pass","issues":[]}`.
 *
 * The cost is not the disagreement — both are correct — it is that the two
 * failure modes are indistinguishable at a glance and want opposite responses:
 *
 *   - new violations introduced by the diff  → fix the code
 *   - pre-existing debt tripping the ratchet → refresh the baseline
 *
 * The `arch` entry in `harness ci check --json` is `{name, status, issues:[],
 * durationMs}` with **zero** error-severity issues in both cases, so nothing in
 * the CI report can tell them apart. These tests pin the behaviour that can:
 * classify the `check-arch --json` report, and say which of the two it is in a
 * sentence a reader cannot misread.
 *
 * The third state is load-bearing too. When the arch check failed and no detail
 * report is available, the summary must SAY it cannot tell — a silent omission
 * there is the same false-green shape (#588) the summariser exists to close.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERDICT = join(REPO_ROOT, 'scripts', 'arch-verdict.mjs');
const SUMMARY = join(REPO_ROOT, 'scripts', 'harness-report-summary.mjs');

interface Violation {
  id: string;
  file: string;
  category: string;
  detail: string;
  severity: string;
}

function violation(
  file: string,
  detail: string,
  id = file + detail,
): Violation {
  return { id, file, category: 'complexity', detail, severity: 'error' };
}

/** The real `harness check-arch --json` shape (harness CLI 11.1.1). */
function archReport(
  overrides: Partial<{
    passed: boolean;
    mode: string;
    newViolations: Violation[];
    resolvedViolations: Violation[];
    preExisting: string[];
    regressions: unknown[];
    thresholdViolations: Violation[];
  }> = {},
) {
  const thresholdViolations = overrides.thresholdViolations ?? [];
  return {
    passed: overrides.passed ?? false,
    mode: overrides.mode ?? 'baseline',
    totalViolations: thresholdViolations.length,
    newViolations: overrides.newViolations ?? [],
    resolvedViolations: overrides.resolvedViolations ?? [],
    preExisting: overrides.preExisting ?? [],
    regressions: overrides.regressions ?? [],
    thresholdViolations,
  };
}

/** The `main`-as-of-#626 report: 28 absolute violations, zero of them new. */
function ratchetTrip() {
  const violations = Array.from({ length: 28 }, (_, i) =>
    violation('ts/src/guardian/coverage.ts', `cyclomaticComplexity=${16 + i}`),
  );
  return archReport({
    passed: false,
    thresholdViolations: violations,
    preExisting: violations.map((v) => v.id),
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arch-verdict-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(name: string, body: unknown | string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf-8',
  );
  return path;
}

function runVerdict(path: string) {
  return runCapture('node', [VERDICT, path]);
}

describe('arch-verdict', () => {
  describe('a ratchet trip and a real regression read differently', () => {
    it('names a pre-existing-only failure a baseline trip, not a regression', () => {
      const r = runVerdict(writeJson('arch.json', ratchetTrip()));
      expect(r.output).toMatch(/baseline/i);
      expect(r.output).toMatch(/0 new/i);
      expect(r.output).toContain('28');
      expect(r.output).not.toMatch(/regression detected/i);
    });

    it('names the allowance file as the route, not the refresh label', () => {
      // #689: the annotation used to recommend `refresh-baseline`, which is
      // NOT how this repo clears module-size growth — six allowance files live
      // on `main` and the label is the rarer maintainer escalation. Four
      // independent workers (#680, #682, #683, #687) read the old text,
      // believed it, and reached the wrong conclusion in a single afternoon.
      // One of them had done the correct denominator check on a pristine
      // `main` worktree and was misled anyway, because the instrument's own
      // advice was wrong.
      const r = runVerdict(writeJson('arch.json', ratchetTrip()));
      expect(r.output).toContain('.harness/arch/allowances/');
      const allowanceAt = r.output.indexOf('.harness/arch/allowances/');
      const labelAt = r.output.indexOf('refresh-baseline');
      expect(allowanceAt).toBeGreaterThanOrEqual(0);
      // The label may still be mentioned, but never before the allowance.
      if (labelAt >= 0) expect(allowanceAt).toBeLessThan(labelAt);
    });

    it('marks the refresh label as the escalation, not the default', () => {
      const r = runVerdict(writeJson('arch.json', ratchetTrip()));
      expect(r.output).toMatch(/escalation|rare|last resort|maintainer/i);
    });

    it('names a new violation a regression and locates it', () => {
      const fresh = violation('ts/src/new.ts', 'cyclomaticComplexity=31');
      const r = runVerdict(
        writeJson(
          'arch.json',
          archReport({
            newViolations: [fresh],
            thresholdViolations: [fresh, violation('ts/src/old.ts', 'old')],
            preExisting: ['ts/src/old.tsold'],
          }),
        ),
      );
      expect(r.output).toMatch(/regression/i);
      expect(r.output).toContain('ts/src/new.ts');
      expect(r.output).toContain('cyclomaticComplexity=31');
    });

    it('treats a baselined-metric regression as a regression too', () => {
      const r = runVerdict(
        writeJson(
          'arch.json',
          archReport({
            regressions: [{ metric: 'complexity', from: 88, to: 94 }],
          }),
        ),
      );
      expect(r.output).toMatch(/regression/i);
    });

    it('labels the regression operands so the pair cannot read as a delta', () => {
      // #689 trap 1: the line printed `module-size 26965 -> 28178`, whose LEFT
      // operand is `baselines.json` — not `main`. Read as a delta it overstates
      // this PR's growth by every allowance ever merged, and the error GROWS
      // over the repo's life. Real deltas in the #680/#682/#683/#687 batch were
      // +55 and +88; the bare arrow implied ~1200 for both.
      const r = runVerdict(
        writeJson(
          'arch.json',
          archReport({
            regressions: [{ metric: 'module-size', from: 26965, to: 28178 }],
          }),
        ),
      );
      expect(r.output).toContain('26965');
      expect(r.output).toContain('28178');
      expect(r.output).toContain('baselines.json');
      expect(r.output).not.toMatch(/26965\s*->\s*28178/);
      expect(r.output).toMatch(
        /not .*(delta|diff|growth)|not this (PR|change)/i,
      );
    });
  });

  describe('the allowance mechanism needs a CLI that honours it (#689 trap 2)', () => {
    function runAt(version: string | undefined) {
      const env = { ...process.env };
      if (version === undefined) delete env.HARNESS_CLI_VERSION;
      else env.HARNESS_CLI_VERSION = version;
      return runCapture(
        'node',
        [VERDICT, writeJson('arch.json', ratchetTrip())],
        {
          env,
        },
      );
    }

    it('warns when the running CLI is too old to read an allowance', () => {
      // Under `@10` the allowance file is ignored ENTIRELY, so a correct
      // allowance appears to do nothing and the author concludes the mechanism
      // is wrong. Every workflow pins `@11`; a local install can differ.
      const r = runAt('10.4.2');
      expect(r.output).toMatch(/10\.4\.2/);
      expect(r.output).toMatch(/ignore/i);
      expect(r.output).toMatch(/11/);
    });

    it('stays quiet about the CLI version when it is new enough', () => {
      const r = runAt('11.1.1');
      expect(r.output).not.toMatch(/too old|ignores? .*allowance/i);
    });

    it('says so when it cannot determine the version, rather than assuming', () => {
      const r = runAt('not-a-version');
      expect(r.output).toMatch(/could not determine|unknown/i);
    });
  });

  describe('exit codes make the local run usable', () => {
    it('exits 0 on a baseline trip, so a clean tree does not fail the developer', () => {
      // `harness check-arch` exits 1 here, which is why nobody runs it locally
      // and the ratchet's own reasoning goes unread.
      const r = runVerdict(writeJson('arch.json', ratchetTrip()));
      expect(r.status).toBe(0);
    });

    it('exits 0 when the report passed outright', () => {
      const r = runVerdict(
        writeJson('arch.json', archReport({ passed: true })),
      );
      expect(r.status).toBe(0);
      expect(r.output).toMatch(/clean|pass/i);
    });

    it('exits 1 when the change introduced a new violation', () => {
      const r = runVerdict(
        writeJson(
          'arch.json',
          archReport({
            newViolations: [violation('ts/src/new.ts', 'complexity=31')],
          }),
        ),
      );
      expect(r.status).toBe(1);
    });
  });

  describe('cannot-classify is a finding, not a skip', () => {
    it('abstains when the report is missing', () => {
      const r = runVerdict(join(dir, 'nope.json'));
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/nope\.json/);
    });

    it('abstains when the report is truncated', () => {
      const r = runVerdict(
        writeJson('arch.json', JSON.stringify(ratchetTrip()).slice(0, 60)),
      );
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/truncat|parse/i);
    });

    it('abstains when the ratchet fields are absent, rather than guessing', () => {
      // A future harness major that drops `newViolations` must not silently
      // read as "no new violations" — that is a fabricated green.
      const r = runVerdict(
        writeJson('arch.json', { passed: false, mode: 'baseline' }),
      );
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/newViolations/);
    });
  });
});

describe('harness-report-summary --arch', () => {
  function ciReport(archStatus: string) {
    const checks = [
      { name: 'validate', status: 'pass', issues: [], durationMs: 5 },
      { name: 'arch', status: archStatus, issues: [], durationMs: 1082 },
    ];
    return {
      version: 1,
      project: 'canary',
      checks,
      summary: {
        total: 2,
        passed: checks.filter((c) => c.status === 'pass').length,
        failed: checks.filter((c) => c.status === 'fail').length,
        warnings: 0,
        skipped: 0,
      },
      exitCode: archStatus === 'fail' ? 1 : 0,
    };
  }

  function runSummary(reportPath: string, archPath?: string) {
    const args = [SUMMARY, reportPath];
    if (archPath !== undefined) args.push('--arch', archPath);
    return runCapture('node', args, { env: { ...process.env } });
  }

  it('explains a failing arch check as a baseline trip when it is one', () => {
    const r = runSummary(
      writeJson('harness-report.json', ciReport('fail')),
      writeJson('arch.json', ratchetTrip()),
    );
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/baseline/i);
    expect(r.output).toMatch(/0 new/i);
  });

  it('annotates a failing arch check that IS a regression as one', () => {
    const r = runSummary(
      writeJson('harness-report.json', ciReport('fail')),
      writeJson(
        'arch.json',
        archReport({
          newViolations: [violation('ts/src/new.ts', 'complexity=31')],
        }),
      ),
    );
    expect(r.output).toMatch(/::error[^\n]*arch/i);
    expect(r.output).toContain('ts/src/new.ts');
  });

  it('says it cannot tell when arch failed with no detail report', () => {
    // The #626 condition exactly: a red arch check with zero error-severity
    // findings and nothing in the report to say which failure mode it was.
    const r = runSummary(writeJson('harness-report.json', ciReport('fail')));
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/cannot/i);
    expect(r.output).toContain('check-arch');
  });

  it('stays quiet about arch when the check passed and no report was given', () => {
    const r = runSummary(writeJson('harness-report.json', ciReport('pass')));
    expect(r.status).toBe(0);
    expect(r.output).not.toMatch(/cannot/i);
  });

  it('does not let an unreadable arch report break the summary', () => {
    const r = runSummary(
      writeJson('harness-report.json', ciReport('fail')),
      join(dir, 'missing.json'),
    );
    expect(r.status).toBe(0);
    expect(r.output).toContain('validate');
    expect(r.output).toMatch(/cannot/i);
  });

  it('abstains on the empty file a crashed check-arch leaves behind', () => {
    // `harness.yml` captures the detail with `… > arch-report.json || true`,
    // so a crashed `check-arch` leaves a zero-byte file rather than no file.
    // Reading that as "nothing new" would be the false green in miniature.
    const r = runSummary(
      writeJson('harness-report.json', ciReport('fail')),
      writeJson('arch.json', ''),
    );
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/cannot/i);
  });
});

describe('#626 wiring — the summary in CI actually gets the split', () => {
  // A classifier nothing calls would leave the next author reading `arch FAIL`
  // exactly as they did on #584, #598 and #621.
  const workflow = readFileSync(
    join(REPO_ROOT, '.github', 'workflows', 'harness.yml'),
    'utf-8',
  );

  it('captures the check-arch detail report', () => {
    expect(workflow).toMatch(/harness check-arch --json > arch-report\.json/);
  });

  it('hands that report to the summariser', () => {
    expect(workflow).toMatch(/--arch arch-report\.json/);
  });

  it('uploads the detail report alongside the ci-check report', () => {
    expect(workflow).toContain('arch-report.json');
  });
});
