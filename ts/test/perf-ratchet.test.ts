/**
 * Contract tests for `scripts/perf-ratchet.mjs` (#717).
 *
 * `harness check-perf` was wired to no workflow at all, so its 237 findings
 * protected nothing. This ratchet wires it the same way `entropy-ratchet.mjs`
 * wired `harness cleanup` (#544): an absolute baseline that may fall and never
 * rise, blocking, with a missing measurement treated as an abstention.
 *
 * The parse is harder here, and the difference is the whole reason this file
 * is long. `harness cleanup` has `--findings-json`, which emits a machine
 * contract line (`{"findings":N,...}`) that is unambiguous and stable.
 * `harness check-perf` has no such flag — measured against CLI 11.1.1, its
 * options are only `--structural`, `--coupling`, `--size` and `--severity`.
 * So this ratchet parses human-readable output, and human-readable output has
 * a failure mode the JSON contract does not:
 *
 *   x Validation failed (237 issues)   <- carries its own denominator
 *   v validation passed                <- carries NOTHING
 *
 * A genuinely clean tree prints the second line. So does a run that measured
 * nothing. Measured at 8c865b5, on the same tree, in the same minute:
 *
 *   harness check-perf              -> x Validation failed (237 issues)
 *   harness check-perf --coupling   -> v validation passed
 *   harness check-perf --size       -> v validation passed
 *
 * The combined run's 237 breaks down as 209 structural + 26 coupling-ratio +
 * 2 import-count findings. `--structural` alone correctly reports its 209.
 * `--coupling` reports a pass over the 28 findings that are *its own subject*.
 * The narrowing flags do not narrow the check, they silence it — and they
 * silence it into a green tick, which is the exact shape ADR 0009 outlaws for
 * canary's own CLI and #718 flags in `check-vocabulary`.
 *
 * That matters here and not in the abstract, because scoping the gate to
 * `--coupling` is the *obvious* way to make check-perf blockable on day one:
 * 28 findings is a tractable backlog and 237 is not. That gate would have been
 * green forever, over nothing. Hence two independent guards:
 *
 *   1. This ratchet treats an IMPLAUSIBLE ZERO as an abstention. A repo
 *      carrying a 237-finding baseline does not reach 0 in one pull request.
 *      A cliff that steep is the signature of a check that stopped measuring,
 *      not of a codebase that got clean, so it exits 3 and says why.
 *   2. `ts/test/workflow-false-green.test.ts` asserts the wired invocation
 *      carries no narrowing flag, so the trap cannot be re-entered upstream of
 *      this script.
 *
 * Neither is sufficient alone. Guard 1 cannot catch a narrowed run once the
 * baseline has been ratcheted down near zero; guard 2 cannot catch an upstream
 * change to what a bare `check-perf` measures. Together they cover both.
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = verified — violations are at or under the baseline
 *   1 = the ratchet fired — violations grew past the baseline
 *   2 = error — the baseline file is missing or unreadable
 *   3 = ABSTENTION — nothing was measured, or the zero is implausible
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
const SCRIPT = join(REPO_ROOT, 'scripts', 'perf-ratchet.mjs');

/** The failure header `harness check-perf` prints, verbatim from CLI 11.1.1. */
function failureHeader(issues: number): string {
  return `x Validation failed (${issues} issues)`;
}

/** The pass line `harness check-perf` prints, verbatim from CLI 11.1.1. */
const PASS_LINE = 'v validation passed';

/** A representative finding body, so reports under test look like real ones. */
const SAMPLE_BODY = [
  '',
  '  * /repo/ts/src/workflow-cli.ts',
  '    File has 345 lines (threshold: 300)',
  '  * /repo/ts/src/workflow-cli.ts',
  '    Function "showCmd" has cyclomatic complexity of 21 (error threshold: 15)',
  '  * /repo/npm/src/router.ts',
  '    Coupling ratio is 1.00 (threshold: 0.7)',
].join('\n');

describe('perf-ratchet', () => {
  let dir: string;
  let report: string;
  let baseline: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perf-ratchet-'));
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

  function writeBaseline(maxViolations: unknown): void {
    writeFileSync(baseline, JSON.stringify({ maxViolations }));
  }

  describe('the ratchet', () => {
    it('passes when violations sit under the baseline', () => {
      writeBaseline(237);
      writeFileSync(report, failureHeader(230) + SAMPLE_BODY);
      const { status, out } = run();
      expect(status).toBe(0);
      expect(out).toContain('230');
      expect(out).toContain('237');
    });

    it('passes when violations exactly equal the baseline', () => {
      writeBaseline(237);
      writeFileSync(report, failureHeader(237) + SAMPLE_BODY);
      expect(run().status).toBe(0);
    });

    it('fails when violations grow past the baseline', () => {
      writeBaseline(237);
      writeFileSync(report, failureHeader(238) + SAMPLE_BODY);
      const { status, out } = run();
      expect(status).toBe(1);
      expect(out).toMatch(/238/);
    });

    it('names the delta so the failure is actionable', () => {
      writeBaseline(237);
      writeFileSync(report, failureHeader(249) + SAMPLE_BODY);
      expect(run().out).toMatch(/\+12/);
    });

    // A ratchet only ratchets if someone tightens it. Mirrors the entropy
    // ratchet's nudge: say so, never fail a codebase that got better.
    it('nudges to lower the baseline when violations fall well below it', () => {
      writeBaseline(300);
      writeFileSync(report, failureHeader(200) + SAMPLE_BODY);
      const { status, out } = run();
      expect(status).toBe(0);
      expect(out).toMatch(/lower/i);
    });
  });

  describe('abstention — nothing was measured', () => {
    // The #544 shape. check-perf exited 2 with "Could not resolve entry
    // points" for months while reporting a colour; a ratchet that reads no
    // number as no violations rebuilds that hiding place one layer up.
    it('ABSTAINS when the output has neither a pass nor a failure header', () => {
      writeBaseline(237);
      writeFileSync(report, 'perf: warn — Could not resolve entry points\n');
      const { status, out } = run();
      expect(status).toBe(3);
      expect(out).toMatch(/ABSTAIN/i);
    });

    it('ABSTAINS on an empty report rather than reading it as zero', () => {
      writeBaseline(237);
      writeFileSync(report, '');
      expect(run().status).toBe(3);
    });

    it('ABSTAINS when the report file does not exist', () => {
      writeBaseline(237);
      expect(run().status).toBe(3);
    });

    // Guards the parse against a cosmetic upstream reword. If the header stops
    // matching, that is an unmeasured run, not a clean one.
    it('ABSTAINS when the failure header carries no parseable count', () => {
      writeBaseline(237);
      writeFileSync(report, 'x Validation failed\n' + SAMPLE_BODY);
      expect(run().status).toBe(3);
    });
  });

  describe('abstention — the implausible zero', () => {
    // The `--coupling` trap. A narrowed run prints the same PASS_LINE a clean
    // tree does, so the only signal available is the size of the cliff.
    it('ABSTAINS on a pass line when the baseline is substantial', () => {
      writeBaseline(237);
      writeFileSync(report, PASS_LINE);
      const { status, out } = run();
      expect(status).toBe(3);
      expect(out).toMatch(/ABSTAIN/i);
    });

    it('explains the implausible zero rather than just refusing', () => {
      writeBaseline(237);
      writeFileSync(report, PASS_LINE);
      const { out } = run();
      // Must name the actual cause a human should check first.
      expect(out).toMatch(/--coupling|--size|--structural|narrow/i);
    });

    it('ABSTAINS on an implausible collapse that is not all the way to zero', () => {
      writeBaseline(237);
      writeFileSync(report, failureHeader(2) + SAMPLE_BODY);
      expect(run().status).toBe(3);
    });

    // The guard must not become a ceiling on genuine progress. Once the
    // baseline is genuinely low, zero is reachable and must be accepted.
    it('accepts a pass line once the baseline is low enough for zero to be real', () => {
      writeBaseline(3);
      writeFileSync(report, PASS_LINE);
      expect(run().status).toBe(0);
    });

    it('accepts a zero baseline paired with a pass line', () => {
      writeBaseline(0);
      writeFileSync(report, PASS_LINE);
      expect(run().status).toBe(0);
    });
  });

  describe('baseline errors', () => {
    it('errors when the baseline file is missing', () => {
      writeFileSync(report, failureHeader(1) + SAMPLE_BODY);
      expect(run().status).toBe(2);
    });

    it('errors when the baseline has no integer maxViolations', () => {
      writeBaseline('lots');
      writeFileSync(report, failureHeader(1) + SAMPLE_BODY);
      expect(run().status).toBe(2);
    });

    // Distinguishes a real 2 from a real 3: a broken baseline is an operator
    // error to fix, an unmeasured run is a gate that did not run. Conflating
    // them sends the reader to the wrong file.
    it('reports a broken baseline as an error even when the report is unmeasured', () => {
      writeBaseline('lots');
      writeFileSync(report, 'garbage\n');
      expect(run().status).toBe(2);
    });
  });
});

/**
 * Instrument-identity abstention (#744) — the perf twin of the block in
 * `ts/test/entropy-ratchet.test.ts`.
 *
 * Both ratchets carry an ABSOLUTE count measured by a CLI the workflows pin as
 * a floating `@harness-engineering/cli@11`, so both have the same hole: the
 * analyzer can change under a fixed ceiling with no commit to this repo, and
 * every offline guard stays green because they compare the baseline against
 * itself.
 *
 * The perf baseline was the quieter case, which is exactly why it needs the
 * same treatment. It recorded 237 violations at CLI 11.1.1 against a ceiling of
 * 245 while the tree measured 225 under both 11.2.0 and 11.3.0 — a smaller gap
 * than entropy's 120, and therefore one nobody would have gone looking for.
 *
 * Note this is NOT covered by the existing implausible-collapse guard above.
 * That fires below 25% of the baseline; 225 against 245 is 92%, and entropy's
 * real 147 against 267 is 55%. A collapse guard catches a detector that goes
 * dark all at once. It cannot catch an instrument that is merely *different*,
 * which is the drift that actually happened, twice.
 */
describe('perf-ratchet instrument identity (#744)', () => {
  let dir: string;
  let report: string;
  let baseline: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perf-ratchet-cli-'));
    report = join(dir, 'report.txt');
    baseline = join(dir, 'baseline.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(cliVersion?: string): { status: number; out: string } {
    const args = [SCRIPT, '--report', report, '--baseline', baseline];
    if (cliVersion !== undefined) args.push('--cli-version', cliVersion);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  function writeBaseline(maxViolations: number, harnessCli?: string): void {
    const body: Record<string, unknown> = { maxViolations };
    if (harnessCli !== undefined) body.harnessCli = harnessCli;
    writeFileSync(baseline, JSON.stringify(body));
  }

  function violationReport(n: number): string {
    return `x Validation failed (${n} issues)\n`;
  }

  it('passes when the running CLI matches the baseline instrument', () => {
    writeBaseline(235, '11.3.0');
    writeFileSync(report, violationReport(225));
    expect(run('11.3.0').status).toBe(0);
  });

  // The real state of `.harness/perf-baseline.json` before this change.
  it('ABSTAINS when the baseline was calibrated on an older CLI', () => {
    writeBaseline(245, '11.1.1');
    writeFileSync(report, violationReport(225));
    const { status, out } = run('11.3.0');
    expect(status).toBe(3);
    expect(out).toMatch(/ABSTAIN/i);
    expect(out).toContain('11.1.1');
    expect(out).toContain('11.3.0');
  });

  it('ABSTAINS rather than FAILING when the instrument also disagrees', () => {
    writeBaseline(245, '11.1.1');
    writeFileSync(report, violationReport(400));
    expect(run('11.3.0').status).toBe(3);
  });

  it('ABSTAINS when the baseline names an instrument and the caller does not', () => {
    writeBaseline(245, '11.1.1');
    writeFileSync(report, violationReport(225));
    const { status, out } = run();
    expect(status).toBe(3);
    expect(out).toMatch(/--cli-version/);
  });

  it('leaves baselines that declare no instrument alone', () => {
    writeBaseline(245);
    writeFileSync(report, violationReport(225));
    expect(run().status).toBe(0);
  });

  // A measurement that never happened outranks one taken on the wrong
  // instrument, and the implausible-collapse guard outranks it too — both are
  // about whether the number means anything at all.
  it('still ABSTAINS on an unparseable report when versions agree', () => {
    writeBaseline(245, '11.3.0');
    writeFileSync(report, 'x Validation failed\n');
    expect(run('11.3.0').status).toBe(3);
  });
});

/**
 * The checked-in perf baseline and its wiring (#744).
 *
 * The entropy baseline has had guards on its real file since #544; this one had
 * none, which is part of why it drifted unnoticed — it recorded 237 violations
 * at CLI 11.1.1 for a week while the tree measured 225.
 *
 * The load-bearing assertion is `harnessCli`. Deleting that key silently
 * disarms the instrument-identity abstention and turns nothing red, which makes
 * it the one edit that has to be caught here rather than in review.
 */
describe('the checked-in perf baseline (#744)', () => {
  const BASELINE = join(REPO_ROOT, '.harness', 'perf-baseline.json');
  const WORKFLOW = join(
    REPO_ROOT,
    '.github',
    'workflows',
    'harness-quality.yml',
  );

  function baselineJson(): Record<string, unknown> {
    return JSON.parse(readFileSync(BASELINE, 'utf8'));
  }

  it('records the exact CLI version that produced its measurement', () => {
    const { harnessCli } = baselineJson();
    expect(typeof harnessCli).toBe('string');
    // A range like "11" or "^11.2.0" would name a family of analyzers rather
    // than the one that produced the count, and the abstention needs identity.
    expect(harnessCli).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('was measured by a CLI whose MAJOR matches the workflow pin', () => {
    const { harnessCli } = baselineJson();
    const yaml = readFileSync(WORKFLOW, 'utf8');
    const pin = /@harness-engineering\/cli@(\d+)/.exec(yaml);
    expect(pin).not.toBeNull();
    expect(String(harnessCli).split('.')[0]).toBe(pin?.[1]);
  });

  it('never sets a ceiling below the count it last measured', () => {
    const { maxViolations, measuredCount } = baselineJson();
    expect(typeof measuredCount).toBe('number');
    expect(maxViolations as number).toBeGreaterThanOrEqual(
      measuredCount as number,
    );
  });

  // The nudge fires above NUDGE_SLACK (20). A ceiling parked further above the
  // measurement than that is the wallpaper state the entropy gate spent four
  // days in, so keep this file inside its own advice.
  it('keeps the ceiling inside the slack the script nudges at', () => {
    const { maxViolations, measuredCount } = baselineJson();
    expect(
      (maxViolations as number) - (measuredCount as number),
    ).toBeLessThanOrEqual(20);
  });

  it('hands the resolved CLI version to the ratchet in CI', () => {
    const yaml = readFileSync(WORKFLOW, 'utf8');
    expect(yaml).toMatch(/perf-ratchet\.mjs[\s\S]{0,200}?--cli-version/);
  });
});
