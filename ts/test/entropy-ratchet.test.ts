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
 * Offline throughout: never runs `harness`, never touches the network. The
 * `entropy-ratchet` block supplies its own report and baseline in a tmpdir; the
 * `the checked-in entropy baseline` block instead reads the REAL
 * `.harness/entropy-baseline.json`, `.github/workflows/harness-quality.yml` and
 * `scripts/entropy-ratchet.mjs`, and shells out to `git show` for the previous
 * committed baseline. Those four are deliberately sensitive to repo state —
 * that is the point of them — which also makes them the only tests here whose
 * result depends on the working tree rather than on inputs they control.
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
 * to a floating major (`@harness-engineering/cli@12`). Those two facts together
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
 * These are offline structural assertions on the JSON. BE PRECISE ABOUT WHAT
 * THEY CAN SEE, because an overclaim here is the same false green they exist to
 * prevent. `measuredCount` is a memory of the last time a human ran the
 * analyzer, NOT a measurement, so nothing below observes the live tree. During
 * the episode above, the file read 291/281 — a self-consistent gap of 10, every
 * assertion green — while the tree measured 257 and the ceiling stood 34 above
 * it. Only the ratchet's own runtime line saw that, and it is a log line.
 *
 * So these catch a HUMAN-EDIT class of defect, which is the class that is
 * checkable without the network:
 *
 *   - the ceiling RAISED above its last committed value (the ratchet's actual
 *     forbidden move, compared against git rather than against a sibling field)
 *   - `maxFindings` moved without re-measuring `measuredCount`
 *   - a missing, range-valued, or major-mismatched `harnessCli`
 *
 * And they explicitly do NOT catch minor-version drift: the workflows pin a
 * floating `@12`, so a 12.1.0 -> 12.2.0 move would pass the major check just as
 * 11.1.1 -> 11.2.0 did. Closing that needs
 * CI to capture the resolved version and the ratchet to abstain on a mismatch
 * (#744). Do not let the presence of this block imply otherwise.
 */
describe('the checked-in entropy baseline', () => {
  const BASELINE_PATH = join(REPO_ROOT, '.harness', 'entropy-baseline.json');
  const BASELINE_REL = '.harness/entropy-baseline.json';
  const WORKFLOW_PATH = join(
    REPO_ROOT,
    '.github',
    'workflows',
    'harness-quality.yml',
  );

  /**
   * Every `HARNESS_CLI` assignment in the quality workflow, as major strings.
   *
   * Anchored to the assignment rather than matched anywhere in the file: a
   * prose comment mentioning an older `@10` used to become the authority,
   * failing the pin test with a message that pointed at the baseline.
   */
  function pinnedMajors(): string[] {
    const yml = readFileSync(WORKFLOW_PATH, 'utf8');
    return [
      ...yml.matchAll(/^\s*HARNESS_CLI:\s*'@harness-engineering\/cli@(\d+)'/gm),
    ].map((m) => m[1]);
  }

  /** The single pinned major, or `?` when the pin is missing or ambiguous. */
  function pinnedMajor(): string {
    const majors = pinnedMajors();
    return majors.length === 1 ? majors[0] : '?';
  }

  /**
   * How to re-measure, quoted into every failure message that needs it. The
   * clean-worktree part is load-bearing: the count reads high in the main
   * working directory (#700), so a re-measure taken in place is worse than
   * none — it is a confident wrong number.
   *
   * The major is READ FROM THE WORKFLOW PIN rather than written here. It used
   * to be a hardcoded `@11`, which made this hint actively harmful in the one
   * case it exists for: the major-mismatch failure quotes it, so a maintainer
   * following it re-measured with the OLD analyzer and reproduced exactly the
   * stale number the guard had just caught. A remediation hint that names a
   * version has to derive it, or it goes stale on precisely the bump that
   * makes someone read it.
   */
  const REMEASURE =
    'Re-measure in a CLEAN WORKTREE (`git worktree add`) with ' +
    `\`npx --yes -p @harness-engineering/cli@${pinnedMajor()} harness cleanup --findings-json\`` +
    ' — the count reads high in the main working dir (#700).';

  function baselineFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  }

  /**
   * Validate the numeric fields once, at the boundary, instead of casting.
   *
   * A blanket `as {...}` cast let a STRING sneak through: `measuredCount:
   * "257"` makes `267 - "257"` coerce to 10, so the headroom assertion passed
   * over a wrongly-typed baseline. Checking here means every assertion below
   * inherits real numbers rather than each one re-deriving that guarantee.
   */
  function baselineNumbers(): {
    maxFindings: number;
    measuredCount: number;
    maxHeadroom: number;
  } {
    const raw = baselineFile();
    for (const key of [
      'maxFindings',
      'measuredCount',
      'maxHeadroom',
    ] as const) {
      expect(
        typeof raw[key],
        `${BASELINE_REL} is missing a numeric "${key}". The ratchet cannot be ` +
          `checked without it — restore the field from git history.`,
      ).toBe('number');
    }
    return raw as unknown as {
      maxFindings: number;
      measuredCount: number;
      maxHeadroom: number;
    };
  }

  // THE ratchet invariant, and the one this block originally missed entirely.
  // Every other assertion here compares two fields of the same file, so raising
  // the ceiling and editing `measuredCount` to match satisfies all of them —
  // which is precisely the move the baseline forbids in prose six times.
  // Git holds the only ground truth that is available offline: the value this
  // file had before the current edit.
  it('never raises the ceiling above its last committed value', () => {
    const prev = spawnSync('git', ['show', `HEAD:${BASELINE_REL}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    // A brand-new file has nothing to ratchet against. Skipping is correct
    // here and is NOT a silent abstention: every other assertion still runs.
    if (prev.status !== 0) return;
    const before = JSON.parse(prev.stdout).maxFindings as number;
    const { maxFindings } = baselineNumbers();
    expect(
      maxFindings,
      `${BASELINE_REL}: the entropy ceiling ROSE ${before} -> ${maxFindings}. ` +
        `A ratchet only turns one way (#544) and raising it to make a failing ` +
        `check pass is the one move that is never right. FIX: fix the new ` +
        `findings, or declare a false-positive entry point in ` +
        `\`entropy.entryPoints\` in harness.config.json. If the ANALYZER moved ` +
        `under you rather than the code, that is still not a raise — record ` +
        `the new \`harnessCli\` and explain it in \`$driftfix\` (see #744).`,
    ).toBeLessThanOrEqual(before);
  });

  it('records the exact CLI version that produced its measurement', () => {
    const cli = baselineFile().harnessCli;
    expect(
      typeof cli,
      `${BASELINE_REL} must record "harnessCli" — the exact version that ` +
        `produced "measuredCount". Without it there is no way to tell a real ` +
        `count change from an analyzer change (#744). ${REMEASURE}`,
    ).toBe('string');
    // A range would defeat the point — the whole failure mode is that `@12`
    // resolves to different analyzers on different days.
    expect(
      cli,
      `${BASELINE_REL}: "harnessCli" is "${String(cli)}", which is a RANGE, ` +
        `not a version. Record what npm actually resolved (e.g. "11.2.0").`,
    ).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // NOTE: major only. A minor bump under the floating `@12` pin — the exact
  // drift that moved this count 24 findings — passes. See the block docblock.
  it('was measured by a CLI whose MAJOR matches the workflow pin', () => {
    const pins = pinnedMajors();
    expect(
      pins.length,
      `No HARNESS_CLI pin found in .github/workflows/harness-quality.yml. If ` +
        `the pin moved or changed shape, point this assertion at its new home ` +
        `— do not delete it.`,
    ).toBe(1);
    const { harnessCli } = baselineFile() as { harnessCli: string };
    expect(
      String(harnessCli).split('.')[0],
      `${BASELINE_REL} was measured with CLI ${String(harnessCli)}, but the ` +
        `workflow now runs major @${pins[0]}. The baseline is stale, not ` +
        `the workflow. FIX: ${REMEASURE} Then update "measuredCount", ` +
        `"measuredAt", "harnessCli", and lower "maxFindings" to the new count ` +
        `plus "maxHeadroom".`,
    ).toBe(pins[0]);
  });

  // The hint is quoted BY the major-mismatch failure above, so a hardcoded
  // major in it is wrong exactly when someone reads it: following it
  // re-measures with the analyzer the baseline is already stale against, and
  // reproduces the stale number. Derive it, or delete the version from it.
  it('quotes a re-measure command naming the major the workflow pins', () => {
    expect(
      REMEASURE,
      `The re-measure hint names a CLI major that is not the pinned ` +
        `@${pinnedMajor()}. It is quoted into the major-mismatch failure, so ` +
        `a stale major here sends the reader back to the wrong analyzer.`,
    ).toContain(`@harness-engineering/cli@${pinnedMajor()} `);
  });

  it('never sets a ceiling below the count it last measured', () => {
    const { maxFindings, measuredCount } = baselineNumbers();
    expect(
      maxFindings,
      `${BASELINE_REL}: "maxFindings" (${maxFindings}) is BELOW ` +
        `"measuredCount" (${measuredCount}), so the gate is red by ` +
        `construction. One of the two was edited without the other.`,
    ).toBeGreaterThanOrEqual(measuredCount);
  });

  // Catches a hand-edit that moved the ceiling without re-measuring. It does
  // NOT see the live tree — see the docblock before assuming otherwise.
  it('keeps the ceiling within the headroom the baseline declares', () => {
    const { maxFindings, measuredCount, maxHeadroom } = baselineNumbers();
    expect(
      maxFindings - measuredCount,
      `${BASELINE_REL}: "maxFindings" (${maxFindings}) sits ` +
        `${maxFindings - measuredCount} above "measuredCount" ` +
        `(${measuredCount}), over the ${maxHeadroom} that "maxHeadroom" ` +
        `allows. A ceiling that far above the tree is not ratcheting. ` +
        `FIX: ${REMEASURE} Then set "measuredCount" to the new number and ` +
        `"maxFindings" to it plus ${maxHeadroom}.`,
    ).toBeLessThanOrEqual(maxHeadroom);
  });

  // The gap lived in three places at two values (25 in the script, 10 in the
  // test, 10 in prose), which made 11-25 a hard test failure the gate itself
  // called fine. The baseline is now the single owner; this pins that.
  it('is the single source of the headroom the ratchet script uses', () => {
    const script = readFileSync(
      join(REPO_ROOT, 'scripts', 'entropy-ratchet.mjs'),
      'utf8',
    );
    expect(
      script,
      `scripts/entropy-ratchet.mjs must read "maxHeadroom" from the baseline ` +
        `rather than hard-coding its own slack — two copies of one policy ` +
        `number means one of them is already wrong.`,
    ).toContain('parsed.maxHeadroom');
  });
});

/**
 * Instrument-identity abstention (#744).
 *
 * The hole this closes is the one `$whatIsGuarded` in the baseline names and
 * that nothing could see: `measuredCount` is a memory of the last time a human
 * ran the analyzer, and the workflows pin a FLOATING `@harness-engineering/
 * cli@12`, so the analyzer under this absolute count can change with no commit
 * to this repo. It happened twice under the old `@11` pin: 11.1.1 -> 11.2.0
 * moved the count 281 -> 257 (#694, a fence-awareness fix), and 11.2.0 ->
 * 11.3.0 then moved it 257 -> 147 — a 110-finding drop, purely subtractive,
 * with the ceiling left at 267. For four days the gate would have taken 120
 * net-new findings to turn red: a blocking check that had been deliberately
 * TIGHTENED to 267 was, in practice, wallpaper.
 *
 * Neither move was catchable offline. The existing guards compare the baseline
 * against ITSELF (the ceiling did not rise, `measuredCount` matches the
 * declared gap, the CLI MAJOR still matches the workflow pin) and every one of
 * them was green the whole time. A floating minor passes a major check by
 * construction.
 *
 * So the count is only meaningful next to the identity of the instrument that
 * produced it. When the baseline declares `harnessCli`, the ratchet must be
 * TOLD which version actually ran, and any disagreement is an ABSTENTION — the
 * measurement is not comparable to the ceiling, so there is nothing to compare.
 * Not a failure (the tree may be perfectly healthy) and emphatically not a
 * pass: it forces the human re-measure that both drift episodes needed.
 *
 * "Cannot verify" is a finding, so a MISSING `--cli-version` abstains too. A
 * baseline that declares its instrument and a caller that will not say which
 * one it ran is precisely the unverifiable state, and letting it through would
 * rebuild the hiding place one layer up — the same reasoning as the missing
 * contract line above.
 *
 * Baselines with no `harnessCli` are unaffected, which is what keeps the
 * tmpdir tests above (and any legacy baseline) meaningful.
 */
describe('entropy-ratchet instrument identity (#744)', () => {
  let dir: string;
  let report: string;
  let baseline: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'entropy-ratchet-cli-'));
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

  function writeBaseline(maxFindings: number, harnessCli?: string): void {
    const body: Record<string, unknown> = { maxFindings };
    if (harnessCli !== undefined) body.harnessCli = harnessCli;
    writeFileSync(baseline, JSON.stringify(body));
  }

  it('passes when the running CLI matches the baseline instrument', () => {
    writeBaseline(157, '11.3.0');
    writeFileSync(report, contractLine(147));
    const { status } = run('11.3.0');
    expect(status).toBe(0);
  });

  // The real 11.2.0 -> 11.3.0 episode: a count well UNDER the ceiling, which
  // every other guard reads as a comfortable pass.
  it('ABSTAINS when a floating pin moved the CLI under a stale baseline', () => {
    writeBaseline(267, '11.2.0');
    writeFileSync(report, contractLine(147));
    const { status, out } = run('11.3.0');
    expect(status).toBe(3);
    expect(out).toMatch(/ABSTAIN/i);
    expect(out).toContain('11.2.0');
    expect(out).toContain('11.3.0');
  });

  // A patch bump is still a different analyzer; #694 shipped in a minor and
  // moved 24 findings, so "close enough" has no defensible cut-off.
  it('ABSTAINS on a patch-level difference, not just a minor one', () => {
    writeBaseline(267, '11.3.0');
    writeFileSync(report, contractLine(147));
    expect(run('11.3.1').status).toBe(3);
  });

  // Would otherwise be the loudest possible false green: over the ceiling AND
  // measured by an instrument the ceiling was never calibrated against.
  it('ABSTAINS rather than FAILING when the instrument also disagrees', () => {
    writeBaseline(267, '11.2.0');
    writeFileSync(report, contractLine(400));
    expect(run('11.3.0').status).toBe(3);
  });

  it('ABSTAINS when the baseline names an instrument and the caller does not', () => {
    writeBaseline(267, '11.2.0');
    writeFileSync(report, contractLine(147));
    const { status, out } = run();
    expect(status).toBe(3);
    expect(out).toMatch(/ABSTAIN/i);
    expect(out).toMatch(/--cli-version/);
  });

  it('leaves baselines that declare no instrument alone', () => {
    writeBaseline(267);
    writeFileSync(report, contractLine(147));
    expect(run().status).toBe(0);
  });

  // Ordering: a MISSING measurement outranks a mismatched instrument. Both
  // abstain, so the exit code is 3 either way, but the operator needs the
  // older and more dangerous shape named first — a scan that died at startup
  // is a different problem from a scan that ran on a different analyzer.
  it('still ABSTAINS on a missing contract line when versions agree', () => {
    writeBaseline(267, '11.3.0');
    writeFileSync(report, 'Entropy analysis failed\n');
    expect(run('11.3.0').status).toBe(3);
  });
});

/**
 * The wiring, not the script (#744).
 *
 * The abstention above is only worth anything if CI actually tells the ratchet
 * which analyzer ran. Two ways to lose that, and both look like a green build:
 *
 * 1. Drop `--cli-version` from the workflow. The ratchet then abstains, CI goes
 *    red, and the tempting "fix" is (2).
 * 2. Delete `harnessCli` from the baseline. The abstention stops firing, the
 *    ceiling goes back to being compared against whatever instrument happened
 *    to run, and nothing anywhere is red. This is the dangerous one, and it is
 *    exactly the move the script's own failure text tells you not to make.
 *
 * These read the REAL workflow and the REAL baseline, so they are deliberately
 * sensitive to repo state.
 */
describe('the entropy ratchet CI wiring (#744)', () => {
  const WORKFLOW = join(
    REPO_ROOT,
    '.github',
    'workflows',
    'harness-quality.yml',
  );

  it('hands the resolved CLI version to the ratchet', () => {
    const yaml = readFileSync(WORKFLOW, 'utf8');
    expect(yaml).toMatch(/entropy-ratchet\.mjs[\s\S]{0,200}?--cli-version/);
  });

  it('resolves that version from the same floating pin the scan uses', () => {
    const yaml = readFileSync(WORKFLOW, 'utf8');
    expect(yaml).toContain('harness --version');
    expect(yaml).toMatch(/id:\s*harness-cli/);
    // A hardcoded version here would defeat the point entirely: it would agree
    // with the baseline forever while the scan floated away from both.
    expect(yaml).toMatch(
      /resolved="\$\(npx --yes -p "\$HARNESS_CLI" harness --version/,
    );
  });

  it('fails the resolve step rather than passing an empty version through', () => {
    const yaml = readFileSync(WORKFLOW, 'utf8');
    expect(yaml).toMatch(/if \[ -z "\$resolved" \]/);
  });

  it('keeps harnessCli in the real baseline, which is what arms the check', () => {
    const baselineFile = join(REPO_ROOT, '.harness', 'entropy-baseline.json');
    const parsed = JSON.parse(readFileSync(baselineFile, 'utf8'));
    expect(typeof parsed.harnessCli).toBe('string');
    expect(parsed.harnessCli).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
