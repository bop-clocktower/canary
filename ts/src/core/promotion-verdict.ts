/**
 * The structured verdict `canary-promote-test` gates on (#477).
 *
 * ## Why this exists now, when the issue says it is blocked
 *
 * #477 was parked on the emit side: `harness:test-craft` runs an 8-axis per-test
 * LLM critique with no machine-readable output, so there was nothing to consume
 * and building a consumer against an unspecified shape meant building it twice.
 * That is still true of the LLM critique. It is no longer true of the gate:
 * #605 (soundness) and #612 (vacuity) emit structured, per-test, DETERMINISTIC
 * verdicts, and those are the ones that were ever going to be allowed to block.
 *
 * ## The three decisions #477 asked for
 *
 * **Which axes gate.** Deterministic defects gate; style reports.
 *
 * | Axis              | Rules                        | Gates | Why                                                              |
 * | ----------------- | ---------------------------- | ----- | ---------------------------------------------------------------- |
 * | `soundness`       | `SOUND-001/002/003`          | yes   | Pins a value no correct implementation must produce              |
 * | `assertions`      | `LINT-006`                   | yes   | A test that asserts nothing always passes                        |
 * | `flakiness`       | `FLAKE-001/002`              | yes   | The issue's own named blocker; both are `critical`               |
 * | `vacuity`         | `VAC-001/003`, annotated 002 | yes   | Deterministic, or the author declared the target themselves      |
 * | `selectors`       | `LINT-001/002/003`           | no    | Brittle, not wrong; a reviewer's call                            |
 * | `maintainability` | `LINT-005`, `FLAKE-003/004`  | no    | Style and softer signals                                        |
 *
 * Gating on all of them would block nearly every promotion, which is exactly the
 * outcome #477 predicted for a naive 8-axis gate.
 *
 * **What happens with no verdict.** `abstain`, exit 3, and say so. Promotion
 * falls back to today's manual review. It must never become silently stricter
 * (a `block` nobody can act on) or silently looser (a `promote` over a file the
 * scanner could not read) -- and two distinct zeros are guarded: a file no
 * ruleset parses, and a parseable file holding no tests.
 *
 * **Whether an LLM judgement may block.** No. Everything that gates in this repo
 * is deterministic, and this change does not spend that. The decision is
 * structural rather than documentary: {@link VerdictSource} admits one value, so
 * there is no field an LLM verdict can arrive in and quietly acquire authority.
 * `harness:test-craft` stays what `canary-promote-test` already calls it -- an
 * optional deeper audit for a human.
 *
 * ## The fidelity ladder
 *
 * `VAC-002` is inference, and #477's real anxiety was making a heuristic
 * load-bearing on a promotion gate. So the rung decides the authority, mirroring
 * the guardian's `coverage-verified > graph-verified > heuristic`:
 * `annotated` (the author named the target) blocks; `import-inferred` reports.
 */

import {
  EXIT_ABSTAINED,
  gateOutcome,
  type GateResult,
  type SkipEntry,
} from './gate-result.js';
import {
  StaticLinter,
  UnsupportedTestFileError,
  frameworkForPath,
  type LintFinding,
} from './static-linter.js';
import {
  scanVacuity,
  type VacuityFidelity,
  type VacuityFinding,
} from './vacuity-scanner.js';

/** Promotion outcomes. `abstain` is never aggregated into either other one. */
export type PromotionDecision = 'promote' | 'block' | 'abstain';

/**
 * Where the verdict's authority comes from. Deliberately a single-member union:
 * see the module docstring on why an LLM verdict has nowhere to land.
 */
export type VerdictSource = 'deterministic';

export type PromotionAxis =
  | 'soundness'
  | 'assertions'
  | 'flakiness'
  | 'vacuity'
  | 'selectors'
  | 'maintainability';

/** One normalized finding, from either producer. */
export interface VerdictFinding {
  rule: string;
  line: number;
  severity: string;
  message: string;
  suggestion: string;
  /** Present only where the rule's confidence varies (`VAC-002`). */
  fidelity?: VacuityFidelity;
}

export interface AxisVerdict {
  axis: PromotionAxis;
  /** Whether a finding on this axis blocks promotion. */
  gating: boolean;
  findings: VerdictFinding[];
}

export interface PromotionVerdict {
  file: string;
  decision: PromotionDecision;
  source: VerdictSource;
  /** Tests inspected. Zero is an abstention, never a pass. */
  checked: number;
  /** Every axis evaluated, gating or not -- see the test on why all of them. */
  axes: AxisVerdict[];
  /** Rules that actually blocked, in report order. */
  blocked: string[];
  skipped: SkipEntry[];
  summaryLine: string;
  /** What a reader should do; non-empty whenever the verdict is not `promote`. */
  remedy: string;
  /** 0 promote, 1 block, 3 abstain -- the repo's #508 exit contract. */
  exitCode: number;
}

/** Which rules land on which axis, and whether that axis gates. */
const AXES: { axis: PromotionAxis; gating: boolean; rules: RegExp }[] = [
  { axis: 'soundness', gating: true, rules: /^SOUND-/ },
  { axis: 'assertions', gating: true, rules: /^LINT-006$/ },
  { axis: 'flakiness', gating: true, rules: /^FLAKE-00[12]$/ },
  { axis: 'vacuity', gating: true, rules: /^VAC-/ },
  { axis: 'selectors', gating: false, rules: /^LINT-00[123]$/ },
  {
    axis: 'maintainability',
    gating: false,
    rules: /^LINT-005$|^FLAKE-00[34]$/,
  },
];

/**
 * Whether a finding on a gating axis may actually block.
 *
 * The one place the fidelity ladder is spent. `VAC-002` at `import-inferred` is
 * an inference about which symbol a test was meant to exercise; blocking a
 * promotion on that would make a heuristic load-bearing, which is the specific
 * thing #477 asked not to do by accident. At `annotated` fidelity the author
 * wrote the target down, so the finding is a contradiction of a stated contract
 * and blocks.
 */
function mayBlock(f: VerdictFinding): boolean {
  if (f.rule !== 'VAC-002') return true;
  return f.fidelity === 'annotated';
}

function normalizeLint(f: LintFinding): VerdictFinding {
  return {
    rule: f.rule,
    line: f.line,
    severity: f.severity,
    message: f.message,
    suggestion: f.suggestion,
  };
}

function normalizeVacuity(f: VacuityFinding): VerdictFinding {
  const out: VerdictFinding = {
    rule: f.rule,
    line: f.line,
    severity: f.severity,
    message: `${f.test}: ${f.message}`,
    suggestion: f.suggestion,
  };
  if (f.fidelity) out.fidelity = f.fidelity;
  return out;
}

const ABSTAIN_REMEDY =
  'No verdict could be produced, so promotion falls back to manual review ' +
  '(canary-promote-test Phase 1) -- it has NOT been approved. ' +
  'Point at a single generated test file that contains at least one test.';

function abstained(
  file: string,
  skipped: SkipEntry[],
  axes: AxisVerdict[],
): PromotionVerdict {
  const outcome = gateOutcome({ checked: 0, findings: [], skipped }, 'gate');
  return {
    file,
    decision: 'abstain',
    source: 'deterministic',
    checked: 0,
    axes,
    blocked: [],
    skipped,
    summaryLine: outcome.summaryLine,
    remedy: ABSTAIN_REMEDY,
    exitCode: EXIT_ABSTAINED,
  };
}

function emptyAxes(): AxisVerdict[] {
  return AXES.map((a) => ({ axis: a.axis, gating: a.gating, findings: [] }));
}

/**
 * Produce the promotion verdict for one generated test file.
 *
 * Deliberately single-file: promotion is a per-file decision, and a directory
 * roll-up would let one clean file's verdict read as cover for a sibling's.
 */
export function promotionVerdict(path: string): PromotionVerdict {
  if (frameworkForPath(path) === null) {
    return abstained(
      path,
      [
        {
          name: path,
          reason:
            'no ruleset parses this extension, so a clean result would be meaningless',
        },
      ],
      emptyAxes(),
    );
  }

  // Two distinct reasons the linter can refuse, and BOTH have to become an
  // abstention rather than an exception. Letting a read error propagate meant
  // the CLI printed a raw ENOENT stack and exited 0 -- a promotion gate that
  // could not open the draft, reporting success. Anything else genuinely
  // unexpected still throws, because swallowing an unknown fault is how a
  // scanner learns to go quiet.
  let lint: LintFinding[];
  try {
    lint = new StaticLinter().lint(path);
  } catch (e) {
    if (e instanceof UnsupportedTestFileError) {
      return abstained(path, [{ name: path, reason: e.message }], emptyAxes());
    }
    const code = (e as { code?: string }).code;
    if (typeof code !== 'string') throw e;
    return abstained(
      path,
      [{ name: path, reason: `could not be read (${code})` }],
      emptyAxes(),
    );
  }
  const vacuity: GateResult<VacuityFinding> = scanVacuity(path);

  const all: VerdictFinding[] = [
    ...lint.map(normalizeLint),
    ...vacuity.findings.map(normalizeVacuity),
  ];

  const axes: AxisVerdict[] = AXES.map((spec) => ({
    axis: spec.axis,
    gating: spec.gating,
    findings: all
      .filter((f) => spec.rules.test(f.rule))
      .sort((a, b) => a.line - b.line),
  }));

  const skipped = vacuity.skipped ?? [];

  // A parseable file with no tests is the second zero, and it must not read as a
  // pass: promotion would let an empty file into the committed suite. Note that
  // `lint` can still be non-empty here (a stray `Date.now()` outside any test),
  // so the check is on the TEST count, not on the finding count.
  if (vacuity.checked === 0) {
    return abstained(
      path,
      [
        ...skipped,
        {
          name: path,
          reason:
            'file holds no test declarations, so there is nothing to promote',
        },
      ],
      axes,
    );
  }

  const blocked = axes
    .filter((a) => a.gating)
    .flatMap((a) => a.findings)
    .filter(mayBlock)
    .map((f) => f.rule);
  const uniqueBlocked = [...new Set(blocked)];

  // `gateOutcome` owns the summary line so promotion reports its denominator in
  // the same shape as every other gate, rather than inventing a private format.
  const outcome = gateOutcome(
    { checked: vacuity.checked, findings: uniqueBlocked, skipped },
    'gate',
    { noun: 'test(s)' },
  );

  const decision: PromotionDecision =
    uniqueBlocked.length > 0 ? 'block' : 'promote';
  const advisoryCount = axes
    .filter((a) => !a.gating)
    .reduce((n, a) => n + a.findings.length, 0);

  return {
    file: path,
    decision,
    source: 'deterministic',
    checked: vacuity.checked,
    axes,
    blocked: uniqueBlocked,
    skipped,
    summaryLine: outcome.summaryLine,
    remedy:
      decision === 'block'
        ? `Blocked on ${uniqueBlocked.join(', ')}. Fix the test or regenerate it ` +
          'with a sharper prompt -- do not hand-patch a generated draft ' +
          '(canary-promote-test Phase 1).'
        : advisoryCount > 0
          ? `Promotable. ${advisoryCount} advisory finding(s) are a reviewer's call, not a blocker.`
          : '',
    exitCode: decision === 'block' ? 1 : 0,
  };
}
