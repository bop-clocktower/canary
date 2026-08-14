/**
 * Contract tests for `scripts/harness-report-summary.mjs` (#588).
 *
 * The summariser exists because the full `harness ci check --json` report is
 * ~162 KB and the Actions log truncates at 60 KB. On PR #584 that cut fell
 * after the fourth of nine checks, so the log showed `pass/pass/warn/warn` and
 * zero error-severity findings on a job that had failed — the real cause,
 * `arch: fail`, sat past the cut with no marker saying anything was missing.
 *
 * So the load-bearing property under test is not "prints a nice summary". It
 * is: **every check in the report appears in the output, and anything the
 * summariser does omit says so with a count.** A summariser that silently
 * drops the tail would reproduce the exact bug it was written to close, just
 * with a smaller payload.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'harness-report-summary.mjs');

interface Issue {
  severity: string;
  message: string;
  file?: string;
  line?: number;
}
interface Check {
  name: string;
  status: string;
  issues: Issue[];
  durationMs: number;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-report-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function check(name: string, status: string, issues: Issue[] = []): Check {
  return { name, status, issues, durationMs: 10 };
}

/** A report with the real nine-check shape from `harness ci check --json`. */
function report(
  overrides: Partial<{ checks: Check[]; exitCode: number }> = {},
) {
  const checks = overrides.checks ?? [
    check('validate', 'pass'),
    check('deps', 'pass'),
    check('docs', 'warn', [{ severity: 'warning', message: 'undocumented' }]),
    check('entropy', 'warn'),
    check('security', 'pass'),
    check('perf', 'warn'),
    check('phase-gate', 'pass'),
    check('arch', 'pass'),
    check('traceability', 'warn'),
  ];
  return {
    version: 1,
    project: 'canary',
    timestamp: '2026-08-08T02:28:14.785Z',
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.status === 'pass').length,
      failed: checks.filter((c) => c.status === 'fail').length,
      warnings: checks.filter((c) => c.status === 'warn').length,
      skipped: checks.filter((c) => c.status === 'skip').length,
    },
    exitCode: overrides.exitCode ?? 0,
  };
}

function write(body: unknown | string): string {
  const path = join(dir, 'harness-report.json');
  writeFileSync(
    path,
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf-8',
  );
  return path;
}

/**
 * A `harness traceability --json` report with a real, non-zero denominator.
 *
 * The nine-check fixture above carries a `traceability` entry, and the
 * summariser now refuses to render one whose denominator it cannot see: that
 * check reads a gitignored, untracked knowledge graph and reports `pass` over
 * ZERO requirements when the graph is absent, which is what it did on every CI
 * run it ever made. These tests are about #588 — check visibility — so they
 * supply a valid denominator and stay on the normal path. The abstention
 * itself is pinned in `traceability-abstention.test.ts`, including the case
 * this helper exists to keep out of the way (omitting it entirely).
 */
function writeTrace(): string {
  const path = join(dir, 'traceability-report.json');
  writeFileSync(
    path,
    JSON.stringify([
      {
        specPath: 'docs/changes/fixture/proposal.md',
        featureName: 'fixture',
        requirements: [
          {
            requirementId: 'req:fixture:1',
            requirementName: 'A traced requirement',
            index: 1,
            codeFiles: [{ path: 'ts/src/cli.ts', confidence: 0.6 }],
            testFiles: [{ path: 'ts/test/cli.test.ts', confidence: 0.6 }],
          },
        ],
      },
    ]),
    'utf-8',
  );
  return path;
}

function run(path: string, env: NodeJS.ProcessEnv = {}) {
  return runCapture('node', [SCRIPT, path, '--traceability', writeTrace()], {
    env: { ...process.env, ...env },
  });
}

describe('harness-report-summary', () => {
  describe('#588 — every check is visible', () => {
    it('names all nine checks with their status', () => {
      const r = run(write(report()));
      expect(r.status).toBe(0);
      for (const c of report().checks) {
        expect(r.output, `${c.name} missing from summary`).toContain(c.name);
      }
    });

    it('shows the failing check that the truncated log used to hide', () => {
      const checks = report().checks.map((c) =>
        c.name === 'arch' ? check('arch', 'fail', []) : c,
      );
      const r = run(write(report({ checks, exitCode: 1 })));
      expect(r.output).toMatch(/fail\s+arch/);
    });

    it('reports the check count so a short summary is self-evidently short', () => {
      const r = run(write(report()));
      expect(r.output).toContain('9 check(s)');
    });

    it('abstains rather than passing when the report has zero checks', () => {
      const r = run(write(report({ checks: [] })));
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/zero checks/i);
    });
  });

  describe('issue detail', () => {
    it('annotates every error-severity issue', () => {
      const checks = [
        check('arch', 'fail', [
          { severity: 'error', message: 'layer breach', file: 'a.ts', line: 4 },
          { severity: 'error', message: 'cycle', file: 'b.ts' },
        ]),
      ];
      const r = run(write(report({ checks, exitCode: 1 })));
      expect(r.output).toContain('layer breach');
      expect(r.output).toContain('a.ts:4');
      expect(r.output).toContain('cycle');
      expect(r.output).toContain('::error');
    });

    it('states the remainder when it caps a long issue list', () => {
      const issues = Array.from({ length: 140 }, (_, i) => ({
        severity: 'warning',
        message: `undocumented ${i}`,
      }));
      const r = run(write(report({ checks: [check('docs', 'warn', issues)] })));
      // The cap is fine; a silent cap is not — #588 is a silent cap.
      expect(r.output).toMatch(/\+\d+ more/);
      expect(r.output).toContain('140');
    });

    it('never caps error-severity issues away', () => {
      const issues = Array.from({ length: 60 }, (_, i) => ({
        severity: 'error',
        message: `breach ${i}`,
      }));
      const r = run(write(report({ checks: [check('arch', 'fail', issues)] })));
      for (let i = 0; i < 60; i++) expect(r.output).toContain(`breach ${i}`);
    });
  });

  describe('cannot-summarise is a finding, not a skip', () => {
    it('abstains when the report file is absent', () => {
      const r = run(join(dir, 'nope.json'));
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/nope\.json/);
    });

    it('abstains when the report is truncated mid-write', () => {
      // Exactly the #588 symptom: valid-looking JSON that just stops.
      const truncated = JSON.stringify(report()).slice(0, 400);
      const r = run(write(truncated));
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/truncat|parse/i);
    });

    it('abstains on a report with no checks array at all', () => {
      const r = run(write({ version: 1, summary: {} }));
      expect(r.status).toBe(3);
    });
  });

  describe('summarising does not re-gate', () => {
    it('exits 0 on a well-formed report that itself failed', () => {
      const checks = [check('arch', 'fail'), check('deps', 'pass')];
      const r = run(write(report({ checks, exitCode: 1 })));
      // The `harness ci check` step already failed the job. A second failure
      // here would just obscure which step is authoritative.
      expect(r.status).toBe(0);
      expect(r.output).toContain('exit 1');
    });
  });

  describe('step summary', () => {
    it('mirrors the summary into GITHUB_STEP_SUMMARY when set', () => {
      const summaryPath = join(dir, 'step-summary.md');
      writeFileSync(summaryPath, '', 'utf-8');
      const r = run(write(report()), { GITHUB_STEP_SUMMARY: summaryPath });
      expect(r.status).toBe(0);
      const written = readFileSync(summaryPath, 'utf-8');
      for (const c of report().checks) expect(written).toContain(c.name);
    });

    it('still summarises to stdout when GITHUB_STEP_SUMMARY is unwritable', () => {
      const r = run(write(report()), {
        GITHUB_STEP_SUMMARY: join(dir, 'no-such-dir', 'summary.md'),
      });
      expect(r.status).toBe(0);
      expect(r.output).toContain('validate');
    });
  });
});
