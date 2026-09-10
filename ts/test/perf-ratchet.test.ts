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

  function run(extra: string[] = []): { status: number; out: string } {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--report', report, '--baseline', baseline, ...extra],
      { encoding: 'utf8' },
    );
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  function writeBaseline(maxViolations: unknown): void {
    writeFileSync(baseline, JSON.stringify({ maxViolations }));
  }

  /**
   * The merge-base delta rule (#812), ported from the entropy ratchet (#703).
   *
   * `maxViolations` is an absolute total, so headroom is a shared budget no
   * branch can see. The perf baseline reached the end of that budget on
   * 2026-09-09: measured 233 against a 233 ceiling, so the next PR adding ONE
   * function-length finding would fail the gate regardless of what its own
   * diff did. With `--base-report`, the ratchet judges the branch on the delta
   * it introduced against the commit it branched from — order-independent,
   * and visible to the author — while the ceiling stays as a backstop.
   */
  describe('merge-base delta (#812)', () => {
    let baseReport: string;

    beforeEach(() => {
      baseReport = join(dir, 'base-report.txt');
    });

    function writeReports(head: number, base: number): void {
      writeFileSync(report, failureHeader(head) + SAMPLE_BODY);
      writeFileSync(baseReport, failureHeader(base) + SAMPLE_BODY);
    }

    /** The zero-headroom state the baseline recorded, as a passing case. */
    it('passes a branch that adds nothing, even with zero absolute headroom', () => {
      writeBaseline(233);
      writeReports(233, 233);
      const { status, out } = run(['--base-report', baseReport]);
      expect(status).toBe(0);
      expect(out).toMatch(/delta OK/);
    });

    it('passes a branch that pays violations down, and shows the negative delta', () => {
      writeBaseline(233);
      writeReports(230, 233);
      const { status, out } = run(['--base-report', baseReport]);
      expect(status).toBe(0);
      expect(out).toMatch(/-3/);
    });

    it('fails a branch that adds violations, and names its own delta', () => {
      writeBaseline(300);
      writeReports(236, 233);
      const { status, out } = run(['--base-report', baseReport]);
      expect(status).toBe(1);
      expect(out).toMatch(/introduces 3/);
      expect(out).toMatch(/233 at the merge base/);
    });

    // A branch that inherits an over-ceiling base should be told "you added
    // 3" rather than handed a total it did not cause, which is why the script
    // evaluates the delta rule ahead of the backstop.
    it('reports the branch delta ahead of an inherited ceiling overage', () => {
      writeBaseline(230);
      writeReports(236, 233);
      const { status, out } = run(['--base-report', baseReport]);
      expect(status).toBe(1);
      expect(out).toMatch(/introduces 3/);
      expect(out).not.toMatch(/absolute backstop/i);
    });

    // The backstop half. Without it a long run of +0 merges could walk the
    // total upward and the delta rule would never notice.
    it('still fires the absolute backstop when the delta is clean', () => {
      writeBaseline(230);
      writeReports(233, 233);
      const { status, out } = run(['--base-report', baseReport]);
      expect(status).toBe(1);
      expect(out).toMatch(/absolute backstop/i);
    });

    // A base that could not be measured is NOT a base of zero. Degrading to
    // the absolute rule would let the delta gate go dark the way check-perf
    // going unwired let the whole check go dark (#717).
    it('ABSTAINS when the base report has neither header', () => {
      writeBaseline(300);
      writeFileSync(report, failureHeader(233) + SAMPLE_BODY);
      writeFileSync(baseReport, 'Could not resolve entry points\n');
      const { status, out } = run(['--base-report', baseReport]);
      expect(status).toBe(3);
      expect(out).toMatch(/merge-base/);
    });

    // Same convention as a missing head report: the workflow step redirects
    // stdout, so an absent file means check-perf died before writing.
    it('ABSTAINS when the named base report does not exist', () => {
      writeBaseline(300);
      writeFileSync(report, failureHeader(233) + SAMPLE_BODY);
      const { status, out } = run(['--base-report', join(dir, 'absent.txt')]);
      expect(status).toBe(3);
      expect(out).toMatch(/merge-base/);
    });

    // A narrowed or startup-failed base scan prints `v validation passed`,
    // which would make ANY head count read as a huge regression. The collapse
    // guard has to protect the base side too.
    it('ABSTAINS when the base scan collapsed implausibly', () => {
      writeBaseline(233);
      writeFileSync(report, failureHeader(233) + SAMPLE_BODY);
      writeFileSync(baseReport, PASS_LINE);
      const { status, out } = run(['--base-report', baseReport]);
      expect(status).toBe(3);
      expect(out).toMatch(/merge-base/);
    });

    // Which side went dark has to be legible from the message alone.
    it('distinguishes a dark head scan from a dark base scan', () => {
      writeBaseline(300);
      writeFileSync(report, 'Could not resolve entry points\n');
      writeFileSync(baseReport, failureHeader(233) + SAMPLE_BODY);
      const { status, out } = run(['--base-report', baseReport]);
      expect(status).toBe(3);
      expect(out).toMatch(/head/);
      expect(out).not.toMatch(/merge-base perf report/);
    });

    it('still ABSTAINS on an instrument mismatch before comparing deltas', () => {
      writeFileSync(
        baseline,
        JSON.stringify({ maxViolations: 300, harnessCli: '12.6.0' }),
      );
      writeReports(233, 233);
      const { status, out } = run([
        '--base-report',
        baseReport,
        '--cli-version',
        '12.7.0',
      ]);
      expect(status).toBe(3);
      expect(out).toMatch(/calibrated against harness CLI 12\.6\.0/);
    });
  });

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
 * a floating `@harness-engineering/cli@12`, so both have the same hole: the
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

/**
 * The delta half is armed in YAML, not in the script (#812). Two invariants
 * the ratchet cannot verify for itself — by the time it runs it holds two
 * integers and no provenance — are asserted here against the workflow, the
 * same way `ts/test/entropy-ratchet.test.ts` asserts them for #703.
 */
describe('the perf merge-base delta gate is wired (#812)', () => {
  const WORKFLOW = join(
    REPO_ROOT,
    '.github',
    'workflows',
    'harness-quality.yml',
  );
  const yaml = (): string => readFileSync(WORKFLOW, 'utf8');

  it('passes --base-report to the ratchet on pull requests', () => {
    expect(yaml()).toMatch(/--base-report\s+perf-base-report\.txt/);
    expect(yaml()).toMatch(/perf-ratchet\.mjs[\s\S]{0,200}?\$PERF_BASE_FLAG/);
  });

  it('gates the base scan on pull_request, so pushes to main still run', () => {
    expect(yaml()).toMatch(
      /Harness Performance Check \(merge base\)[\s\S]{0,200}?if:\s*github\.event_name == 'pull_request'/,
    );
  });

  it('measures the base with the same floating pin as the head scan', () => {
    // Not a hardcoded version, and not a second pin: the same `$HARNESS_CLI`
    // the resolve step reported. Two analyzers produce a delta that is pure
    // instrument drift.
    const scans = [
      ...yaml().matchAll(/npx --yes -p "\$HARNESS_CLI" harness check-perf/g),
    ];
    expect(scans.length).toBe(2);
  });

  it('puts the base worktree outside the checkout', () => {
    // Inside `$GITHUB_WORKSPACE` the head scan walks the base tree and counts
    // every violation twice, which inflates BOTH numbers and quietly changes
    // what the delta means.
    expect(yaml()).toMatch(
      /git worktree add --detach "\$RUNNER_TEMP\/perf-base"/,
    );
    expect(yaml()).not.toMatch(/git worktree add[^\n]*\$GITHUB_WORKSPACE/);
  });
});

/**
 * Structural allowances for the merge-base delta rule (#850).
 *
 * The delta rule compared two SCALAR counts, which made it blind to what the
 * findings were — and that blindness had a direction. `harness check-perf`
 * flags a coupling ratio of 1.00, which is the definition of a CLI wiring
 * module (it imports many things and is imported by few), so every one of this
 * repo's five CLI modules already carries one. Adding a subcommand in a NEW
 * module therefore cost +2 findings and failed the delta rule, while adding
 * the same subcommand to `ts/src/cli.ts` — already over the 300-line threshold
 * and already carrying both findings — cost +0, because a file that is already
 * flagged for a rule does not get flagged twice.
 *
 * The gate was cheapest to satisfy by making an oversized file more oversized.
 * PR #851 paid the tax the honest way, retiring six findings in
 * `workflow-cli.ts` to buy room for two.
 *
 * The fix is to diff finding IDENTITIES rather than counts, so a reviewed
 * allowance can exempt the structural findings that a legitimate module shape
 * causes. Two properties keep an allowance list from becoming the false-green
 * it is trying to prevent:
 *
 *   1. Every allowance MUST carry a `why`, and an applied allowance is NAMED
 *      in the output — a suppressed finding stays visible, never silent.
 *   2. The allowances apply ONLY to the delta rule. The absolute ceiling still
 *      counts every finding, allowed or not, so an allowance can never lower
 *      the total this repo is held to.
 *
 * Deliberately NOT fixed here (tracked separately): growth of an ALREADY
 * flagged finding is still free, because identity ignores magnitude. A test
 * below pins that as known and open rather than leaving it to be discovered.
 */
describe('perf-ratchet structural allowances (#850)', () => {
  let dir: string;
  let report: string;
  let baseReport: string;
  let baseline: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perf-allow-'));
    report = join(dir, 'report.txt');
    baseReport = join(dir, 'base-report.txt');
    baseline = join(dir, 'baseline.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(extra: string[] = []): { status: number; out: string } {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--report', report, '--baseline', baseline, ...extra],
      { encoding: 'utf8' },
    );
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  /**
   * Run with both scan roots declared. The head scan runs in the checkout and
   * the merge-base scan in a worktree deliberately outside it, so the two
   * reports name the same file under different absolute roots. The roots are
   * passed explicitly so alignment is derived, never guessed.
   */
  function runDelta(): { status: number; out: string } {
    return run([
      '--base-report',
      baseReport,
      '--report-root',
      HEAD_ROOT,
      '--base-report-root',
      BASE_ROOT,
    ]);
  }

  /** Build a report whose findings live under `root`, as a real scan's do. */
  function reportText(root: string, findings: [string, string][]): string {
    const body = findings
      .map(([file, message]) => `  * ${root}/${file}\n    ${message}`)
      .join('\n');
    return `x Validation failed (${findings.length} issues)\n\n${body}\n`;
  }

  /** The checkout the head scan runs in, as GitHub Actions names it. */
  const HEAD_ROOT = '/home/runner/work/canary/canary';
  /** The merge-base worktree, deliberately outside the checkout. */
  const BASE_ROOT = '/home/runner/_temp/perf-base';

  const COUPLING = 'Coupling ratio is 1.00 (threshold: 0.7)';
  const SIZE_310 = 'File has 310 lines (threshold: 300)';

  /** The findings a stable base tree carries, before the branch touches it. */
  const BASE: [string, string][] = [
    ['ts/src/cli.ts', COUPLING],
    ['ts/src/cli.ts', 'File has 377 lines (threshold: 300)'],
    ['ts/src/guardian/cli.ts', COUPLING],
  ];

  /**
   * A deliberately SMALL ceiling. `isImplausibleCollapse` only engages once the
   * baseline reaches COLLAPSE_GUARD_MIN_BASELINE (20), so a large ceiling here
   * would abstain on these few-finding fixtures before the delta rule ever ran
   * — and every assertion below would be testing the collapse guard instead.
   */
  function writeBaseline(extra: Record<string, unknown> = {}): void {
    writeFileSync(baseline, JSON.stringify({ maxViolations: 10, ...extra }));
  }

  /**
   * THE LANDMINE. The head scan runs in `$GITHUB_WORKSPACE`; the merge-base
   * scan runs in `$RUNNER_TEMP/perf-base`, deliberately outside the checkout.
   * So the two reports name the SAME file under DIFFERENT absolute roots. A
   * naive identity diff sees every base finding vanish and every head finding
   * appear, and fires on a branch that changed nothing.
   */
  it('aligns findings across the two different scan roots', () => {
    writeBaseline();
    writeFileSync(report, reportText(HEAD_ROOT, BASE));
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    expect(status).toBe(0);
    expect(out).toMatch(/delta OK/);
  });

  it('still fails a genuinely new finding, and names the file', () => {
    writeBaseline();
    writeFileSync(
      report,
      reportText(HEAD_ROOT, [...BASE, ['ts/src/history/cli.ts', SIZE_310]]),
    );
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    expect(status).toBe(1);
    expect(out).toMatch(/ts\/src\/history\/cli\.ts/);
  });

  it('allows a coupling finding on a new CLI module, and names the allowance', () => {
    writeBaseline({
      deltaAllowances: [
        {
          rule: 'coupling',
          path: 'ts/src/**/cli.ts',
          why: 'a CLI wiring module triggers the coupling rule by definition',
        },
      ],
    });
    writeFileSync(
      report,
      reportText(HEAD_ROOT, [...BASE, ['ts/src/history/cli.ts', COUPLING]]),
    );
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    expect(status).toBe(0);
    // The suppressed finding must stay VISIBLE — an allowance that applies
    // silently is the false green this whole file exists to prevent.
    expect(out).toMatch(/ts\/src\/history\/cli\.ts/);
    expect(out).toMatch(/wiring module triggers the coupling rule/);
  });

  it('does not let an allowance cover a rule it does not name', () => {
    // The allowance is for coupling; the new finding is a size violation.
    writeBaseline({
      deltaAllowances: [
        { rule: 'coupling', path: 'ts/src/**/cli.ts', why: 'wiring module' },
      ],
    });
    writeFileSync(
      report,
      reportText(HEAD_ROOT, [...BASE, ['ts/src/history/cli.ts', SIZE_310]]),
    );
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status } = runDelta();
    expect(status).toBe(1);
  });

  it('does not let an allowance cover a path it does not match', () => {
    writeBaseline({
      deltaAllowances: [
        { rule: 'coupling', path: 'ts/src/**/cli.ts', why: 'wiring module' },
      ],
    });
    writeFileSync(
      report,
      reportText(HEAD_ROOT, [...BASE, ['ts/src/analysis/parser.ts', COUPLING]]),
    );
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status } = runDelta();
    expect(status).toBe(1);
  });

  it('refuses an allowance with no stated reason', () => {
    // An allowance list that can grow by one unexplained line is how a gate
    // rots. `why` is load-bearing, so its absence is a config ERROR.
    writeBaseline({
      deltaAllowances: [{ rule: 'coupling', path: 'ts/src/**/cli.ts' }],
    });
    writeFileSync(report, reportText(HEAD_ROOT, BASE));
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    expect(status).toBe(2);
    expect(out).toMatch(/why/i);
  });

  it('refuses an allowance naming a rule that does not exist', () => {
    // A typo'd rule name would silently match nothing and look exactly like a
    // working allowance — right up until the day it was needed. Rejecting it
    // at config time is the difference between a gate and a decoration.
    writeBaseline({
      deltaAllowances: [
        { rule: 'coupling-ratio', path: 'ts/src/**', why: 'typo' },
      ],
    });
    writeFileSync(report, reportText(HEAD_ROOT, BASE));
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    expect(status).toBe(2);
    expect(out).toMatch(/unknown rule/i);
    // The message must name the legal values, or the author is left guessing.
    expect(out).toMatch(/coupling/);
  });

  it('refuses a deltaAllowances that is not an array', () => {
    writeBaseline({ deltaAllowances: { rule: 'coupling' } });
    writeFileSync(report, reportText(HEAD_ROOT, BASE));
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    expect(status).toBe(2);
    expect(out).toMatch(/non-array/i);
  });

  it('reports an allowance that covers nothing in the tree', () => {
    // Coverage that is no longer needed should be visible, so the list can be
    // pruned instead of accumulating forever.
    writeBaseline({
      deltaAllowances: [
        { rule: 'coupling', path: 'does/not/exist/**', why: 'stale entry' },
      ],
    });
    writeFileSync(report, reportText(HEAD_ROOT, BASE));
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    expect(status).toBe(0);
    expect(out).toMatch(/covers no finding/i);
  });

  it('stays quiet about an allowance that still covers the tree', () => {
    // Staleness is judged against ALL head findings, not just the ones an
    // allowance suppressed on this run. Most PRs add no finding at all, so
    // "did it apply?" would flag every allowance on nearly every run — noise
    // that trains people to skip the line.
    writeBaseline({
      deltaAllowances: [
        { rule: 'coupling', path: 'ts/src/**/cli.ts', why: 'wiring module' },
      ],
    });
    writeFileSync(report, reportText(HEAD_ROOT, BASE));
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    expect(status).toBe(0);
    expect(out).not.toMatch(/covers no finding/i);
  });

  it('falls back to the count rule when a report does not parse completely', () => {
    // The header carries the denominator. When the body does not account for
    // it, the identity set is NOT the set that was measured, so allowances
    // cannot be applied honestly. The count rule still governs, and the
    // downgrade is announced rather than assumed.
    writeBaseline({
      maxViolations: 10,
      deltaAllowances: [
        { rule: 'coupling', path: 'ts/src/**/cli.ts', why: 'wiring module' },
      ],
    });
    writeFileSync(
      report,
      `x Validation failed (8 issues)\n\n  * ${HEAD_ROOT}/ts/src/a.ts\n    ${COUPLING}\n`,
    );
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    // 8 here against 3 at the base: the count rule fires.
    expect(status).toBe(1);
    expect(out).toMatch(/count/i);
  });

  it('abstains when the two reports share no file at all', () => {
    // Non-empty on both sides and zero overlap means the roots did not align.
    // Reporting "everything is new" there is a false RED built on a bad parse.
    writeBaseline();
    writeFileSync(report, reportText(HEAD_ROOT, [['ts/src/a.ts', COUPLING]]));
    writeFileSync(
      baseReport,
      reportText(BASE_ROOT, [['other/b.ts', COUPLING]]),
    );
    const { status, out } = runDelta();
    expect(status).toBe(3);
    expect(out).toMatch(/align/i);
  });

  it('keeps the absolute ceiling blind to allowances', () => {
    // An allowance buys room in the DELTA rule only. If it could also lower
    // the total, the ceiling would drift upward invisibly.
    writeBaseline({
      maxViolations: 3,
      deltaAllowances: [
        { rule: 'coupling', path: 'ts/src/**/cli.ts', why: 'wiring module' },
      ],
    });
    writeFileSync(
      report,
      reportText(HEAD_ROOT, [...BASE, ['ts/src/history/cli.ts', COUPLING]]),
    );
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status, out } = runDelta();
    expect(status).toBe(1);
    expect(out).toMatch(/absolute backstop/);
  });

  it('counts repeated identical findings, and catches one more of them', () => {
    // Identity is not unique per file. `ts/src/core/migrator.ts` really does
    // carry THREE `for` function-length findings, so the 236 findings measured
    // on main collapse to 230 distinct identities. Comparing sets rather than
    // multisets would let a branch add a fourth and have it swallowed by the
    // third — a silent regression in the exact class this gate exists to catch.
    const FOR_LEN = 'Function "for" is 60 lines long (threshold: 50)';
    const twice: [string, string][] = [
      ['ts/src/core/migrator.ts', FOR_LEN],
      ['ts/src/core/migrator.ts', FOR_LEN],
    ];
    writeBaseline();
    writeFileSync(
      report,
      reportText(HEAD_ROOT, [...twice, ['ts/src/core/migrator.ts', FOR_LEN]]),
    );
    writeFileSync(baseReport, reportText(BASE_ROOT, twice));
    const { status, out } = runDelta();
    expect(status).toBe(1);
    expect(out).toMatch(/1 performance violation/);
  });

  it('passes when the same repeated findings are unchanged', () => {
    const FOR_LEN = 'Function "for" is 60 lines long (threshold: 50)';
    const twice: [string, string][] = [
      ['ts/src/core/migrator.ts', FOR_LEN],
      ['ts/src/core/migrator.ts', FOR_LEN],
    ];
    writeBaseline();
    writeFileSync(report, reportText(HEAD_ROOT, twice));
    writeFileSync(baseReport, reportText(BASE_ROOT, twice));
    const { status } = runDelta();
    expect(status).toBe(0);
  });

  it('KNOWN GAP: growth of an already-flagged finding is still free', () => {
    // Identity ignores magnitude, so cli.ts going 377 -> 900 lines is the same
    // finding and the delta rule stays green. This is the second half of #850
    // and is deliberately out of scope here; pinned so it is a recorded
    // decision rather than a surprise.
    writeBaseline();
    writeFileSync(
      report,
      reportText(HEAD_ROOT, [
        ['ts/src/cli.ts', COUPLING],
        ['ts/src/cli.ts', 'File has 900 lines (threshold: 300)'],
        ['ts/src/guardian/cli.ts', COUPLING],
      ]),
    );
    writeFileSync(baseReport, reportText(BASE_ROOT, BASE));
    const { status } = runDelta();
    expect(status).toBe(0);
  });
});
