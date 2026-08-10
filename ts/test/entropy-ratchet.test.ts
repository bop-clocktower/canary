/**
 * Contract tests for `scripts/entropy-ratchet.mjs` (#544).
 *
 * The bug this closes has two layers, and the second is the interesting one.
 *
 * Layer 1 — the step never ran. `Harness Cleanup (Entropy Scan)` exited 2 with
 * "Could not resolve entry points" because `entryPoints` sat at a config path
 * the schema never read. That was fixed by moving the key to
 * `entropy.entryPoints`, and the scan started reporting 718 findings.
 *
 * Layer 2 — the value at the corrected key was *also* wrong, and it produced a
 * number instead of an error, which is worse. The single declared entry point
 * was `ts/bin/canary.js`. `bin` and `dist` are both members of the harness
 * analyzer's `DEFAULT_SKIP_DIRS`, so the one root of the reachability graph was
 * invisible to the scanner, and the file it imports (`../dist/cli.js`) was
 * invisible too. The graph therefore started from nothing, and **every one of
 * the 175 scanned non-test source files came back "dead"** — a 100%-of-scope
 * false positive wearing a 770-finding costume. A check that flags the entire
 * denominator has not measured the codebase; it has abstained.
 *
 * So this gate has to defend two properties at once:
 *
 * 1. The findings count may not grow past the triaged baseline
 *    (`.harness/entropy-baseline.json`). That is the ratchet the issue asked
 *    for, and it replaces `continue-on-error: true` on the workflow step.
 *
 * 2. A *missing* count is a failure, never a pass. If `harness cleanup` dies
 *    at startup again, or the `--findings-json` contract line disappears from
 *    its output, this script must exit non-zero rather than sail through on an
 *    empty parse. That is the specific shape that kept the step green for
 *    months, and a ratchet that can be satisfied by silence would reintroduce
 *    it at a new layer.
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = verified — findings are at or under the baseline
 *   1 = the ratchet fired — findings grew past the baseline
 *   2 = error — the baseline file is missing or unreadable
 *   3 = ABSTENTION — no findings line in the input, so nothing was measured
 *
 * Offline: reads a report file and a baseline file, both supplied by the test.
 * Never runs `harness` and never touches the network.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'entropy-ratchet.mjs');

/** The trailing contract line `harness cleanup --findings-json` emits (#691). */
function contractLine(findings: number): string {
  return JSON.stringify({ findings, v: 1, check: 'cleanup' });
}

describe('entropy-ratchet', () => {
  let dir: string;
  let report: string;
  let baseline: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'entropy-ratchet-'));
    report = join(dir, 'report.txt');
    baseline = join(dir, 'baseline.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(): { status: number; out: string } {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--report', report, '--baseline', baseline],
      { encoding: 'utf8' },
    );
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  function writeBaseline(maxFindings: number): void {
    writeFileSync(baseline, JSON.stringify({ maxFindings }));
  }

  it('passes when findings sit under the baseline', () => {
    writeBaseline(340);
    writeFileSync(report, `noise\n${contractLine(330)}\n`);
    const { status, out } = run();
    expect(status).toBe(0);
    expect(out).toContain('330');
    expect(out).toContain('340');
  });

  it('passes when findings exactly equal the baseline', () => {
    writeBaseline(330);
    writeFileSync(report, contractLine(330));
    expect(run().status).toBe(0);
  });

  it('fails when findings grow past the baseline', () => {
    writeBaseline(330);
    writeFileSync(report, contractLine(331));
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/331/);
  });

  it('names the delta so the failure is actionable', () => {
    writeBaseline(300);
    writeFileSync(report, contractLine(312));
    const { out } = run();
    expect(out).toMatch(/\+12/);
  });

  // The whole point of the exercise. `harness cleanup` printed a startup error
  // and no contract line for months while the job stayed green; a ratchet that
  // treats "no number" as "no findings" would re-run that movie.
  it('ABSTAINS rather than passing when no contract line is present', () => {
    writeBaseline(330);
    writeFileSync(
      report,
      'Entropy analysis failed: Could not resolve entry points\n',
    );
    const { status, out } = run();
    expect(status).toBe(3);
    expect(out).toMatch(/ABSTAIN/i);
  });

  it('ABSTAINS on an empty report rather than reading it as zero findings', () => {
    writeBaseline(330);
    writeFileSync(report, '');
    expect(run().status).toBe(3);
  });

  it('reads the LAST contract line when the tool emits more than one', () => {
    writeBaseline(330);
    writeFileSync(report, `${contractLine(1)}\n${contractLine(331)}\n`);
    expect(run().status).toBe(1);
  });

  it('ignores a findings line belonging to a different check', () => {
    writeBaseline(330);
    writeFileSync(
      report,
      `${JSON.stringify({ findings: 9999, v: 1, check: 'check-docs' })}\n`,
    );
    expect(run().status).toBe(3);
  });

  it('errors when the baseline file is missing', () => {
    writeFileSync(report, contractLine(1));
    expect(run().status).toBe(2);
  });

  it('errors when the baseline has no numeric maxFindings', () => {
    writeFileSync(baseline, JSON.stringify({ maxFindings: 'lots' }));
    writeFileSync(report, contractLine(1));
    expect(run().status).toBe(2);
  });

  // A ratchet only ratchets if someone tightens it. Slack this large means the
  // triage moved and the baseline did not — say so, but do not fail the build
  // for a codebase that got cleaner.
  it('nudges to lower the baseline when findings fall well below it', () => {
    writeBaseline(400);
    writeFileSync(report, contractLine(300));
    const { status, out } = run();
    expect(status).toBe(0);
    expect(out).toMatch(/lower/i);
  });
});
