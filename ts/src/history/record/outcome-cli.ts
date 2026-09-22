/**
 * How `canary history record` reports what it did -- the `--json` payload, the
 * dry-run line, and the success line.
 *
 * Split from `cli.ts` for #1074 so the command module stays about the decision
 * to record and this one about describing the result. The two share
 * {@link countsLine}, which is why the shape cannot drift between `--json` and
 * the human line.
 *
 * Named `*-cli.ts` on purpose: layer binding is by filename
 * (`ts/src/**\/*cli*.ts` is the `cli` layer, first match wins), and this module
 * imports `cli-common` for Python `json.dumps(x, indent=2)` fidelity.
 */

import pc from 'picocolors';

import { CliExitError, jsonIndent2 } from '../../cli-common.js';
import { gateOutcome } from '../../core/gate-result.js';
import type { BuiltRun, ReportShape } from '../run-recorder.js';
import type { KeyedRun } from '../keys/replay-context.js';
import type { HistoryDeps } from '../cli-deps.js';

/**
 * The slice of `record`'s options this module needs.
 *
 * Structural rather than an import of `RecordOptions` from `cli.ts`: that
 * module imports this one, and a type cycle between a command and its own
 * output rendering is the kind of knot that survives until someone reaches for
 * a value import and it breaks at runtime.
 */
interface OutcomeOptions {
  suite: string;
  json?: boolean;
}

/** The `flaky: 0` caveat, printed rather than buried in a source comment. */
const FLAKY_VOCABULARY_NOTE =
  'note: flaky=0 \u{2014} vitest reports no flaky status, so a test that was ' +
  'retried and then passed is recorded as passed.';

/** The join denominator, printed on every success so a 0 is a measurement. */
function printUnjoinable(built: KeyedRun, deps: HistoryDeps): void {
  deps.out(
    `unjoinableTestFiles: ${built.unjoinable} of ${built.results.length}`,
  );
}

/** vitest cannot report a flake; Playwright can, so its `flaky` is real. */
function printFlakyNote(shape: ReportShape, deps: HistoryDeps): void {
  if (shape === 'vitest') deps.out(FLAKY_VOCABULARY_NOTE);
}

/** The success payload/line. Shared shape so `--json` cannot drift from it. */
function recordPayload(
  built: KeyedRun,
  target: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const { run } = built;
  return {
    run_id: run.run_id,
    suite: run.suite,
    repo: run.repo,
    target,
    checked: built.results.length,
    passed: run.passed,
    failed: run.failed,
    flaky: run.flaky,
    skipped: run.skipped,
    unjoinableTestFiles: built.unjoinable,
    abstained: false,
    ...extra,
  };
}

export function countsLine(built: BuiltRun): string {
  const { run } = built;
  return (
    `${built.results.length} result(s) for ${pc.bold(run.suite)} ` +
    `(${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped)`
  );
}

export function reportDryRun(
  built: KeyedRun,
  target: string,
  opts: OutcomeOptions,
  deps: HistoryDeps,
  shape: ReportShape,
): void {
  if (opts.json) {
    deps.out(
      jsonIndent2(
        recordPayload(built, target, { recorded: false, dry_run: true }),
      ),
    );
    return;
  }
  deps.out(
    `${pc.cyan('dry-run:')} would record ${countsLine(built)} as ` +
      `${pc.bold(built.run.run_id)} \u{2192} ${target}`,
  );
  printUnjoinable(built, deps);
  printFlakyNote(shape, deps);
}

export function reportRecorded(
  built: KeyedRun,
  target: string,
  opts: OutcomeOptions,
  deps: HistoryDeps,
  shape: ReportShape,
): void {
  if (opts.json) {
    deps.out(jsonIndent2(recordPayload(built, target, { recorded: true })));
    return;
  }
  deps.out(`${pc.green('Recorded')} ${countsLine(built)} \u{2192} ${target}`);
  deps.out(`run_id: ${built.run.run_id}`);
  printUnjoinable(built, deps);
  printFlakyNote(shape, deps);
}

export function abstainOnEmptyReport(
  resultsFile: string,
  opts: OutcomeOptions,
  deps: HistoryDeps,
): void {
  const outcome = gateOutcome({ checked: 0, findings: [] }, 'gate');
  const notice =
    `${outcome.summaryLine} ${resultsFile} carried zero test results, so ` +
    `nothing was recorded \u{2014} an empty run is the denominator ` +
    `collapsing, not a passing suite. Check that the runner wrote its report ` +
    `(\`vitest --reporter=json --outputFile=<path>\`, or Playwright ` +
    `\`--reporter=json\` with \`PLAYWRIGHT_JSON_OUTPUT_NAME=<path>\`, or a ` +
    `JUnit XML file such as \`pytest --junitxml=<path>\`) and ` +
    `that the suite ran.`;
  if (opts.json) {
    deps.out(
      jsonIndent2({
        suite: opts.suite,
        checked: 0,
        recorded: false,
        abstained: true,
      }),
    );
    deps.err(notice);
  } else {
    deps.out(notice);
  }
  throw new CliExitError(outcome.exitCode);
}
