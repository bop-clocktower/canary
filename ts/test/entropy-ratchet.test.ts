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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The checked-in baseline, as opposed to the script that reads it (#744).
 *
 * `maxFindings` is an ABSOLUTE count, but the workflows pin the measuring tool
 * to a floating major (`@harness-engineering/cli@11`). Those two facts together
 * mean a patch release can move the number with no change to this repo at all,
 * and it has: measured on one commit, CLI 11.1.1 reports 281 findings and
 * 11.2.0 reports 257 — a 24-finding move that is entirely the doc-drift
 * category upstream stopped false-positiving on (#694).
 *
 * Both directions of that are bad and only one of them is loud. A tightened
 * rule blocks a PR whose diff cannot explain the failure (that cost #743 four
 * days). A loosened one hands the ratchet slack it never earned, and the gate
 * keeps reporting OK while defending a ceiling far above what the tree needs —
 * a ratchet that is 34 under its own ceiling is not ratcheting, it is a number
 * nobody is holding.
 *
 * These are offline structural assertions on the JSON. They cannot re-measure
 * the tree (that needs the analyzer and the network), so they pin the next best
 * thing: the file has to say which instrument produced its number, and the
 * ceiling has to stay within the headroom the file itself documents.
 */
describe('the checked-in entropy baseline', () => {
  const BASELINE_PATH = join(REPO_ROOT, '.harness', 'entropy-baseline.json');

  /**
   * The deliberate gap between the ceiling and the last measurement, from the
   * baseline's own `$headroom` note. It is not zero on purpose: the ratchet is
   * an absolute total, so concurrent branches spend a shared budget none of
   * them can see (#703), and a ceiling pinned exactly to the measurement fails
   * the next single green PR that adds one finding.
   */
  const MAX_HEADROOM = 10;

  function baselineFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  }

  it('records the exact CLI version that produced its measurement', () => {
    const cli = baselineFile().harnessCli;
    expect(typeof cli).toBe('string');
    // A range would defeat the point — the whole failure mode is that `@11`
    // resolves to different analyzers on different days.
    expect(cli).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('was measured by the CLI major the workflow actually runs', () => {
    const pinned = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'harness-quality.yml'),
      'utf8',
    ).match(/@harness-engineering\/cli@(\d+)/);
    expect(pinned).not.toBeNull();
    const measuredMajor = String(baselineFile().harnessCli).split('.')[0];
    expect(measuredMajor).toBe(pinned?.[1]);
  });

  it('never sets a ceiling below the count it last measured', () => {
    const { maxFindings, measuredCount } = baselineFile() as {
      maxFindings: number;
      measuredCount: number;
    };
    expect(typeof measuredCount).toBe('number');
    expect(maxFindings).toBeGreaterThanOrEqual(measuredCount);
  });

  it('keeps the ceiling within the headroom it documents', () => {
    const { maxFindings, measuredCount } = baselineFile() as {
      maxFindings: number;
      measuredCount: number;
    };
    // The assertion that catches a stale ceiling after the analyzer moves
    // under it — the state CI nags about on every run and nothing enforces.
    expect(maxFindings - measuredCount).toBeLessThanOrEqual(MAX_HEADROOM);
  });
});
