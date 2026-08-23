#!/usr/bin/env node
// Refreshes `.harness/arch/baselines.json` from a `check-arch --json` report (#749).
//
// This exists because the CLI stopped offering a refresh. At harness 11.x,
// `check-arch --update-baseline` — with or without `--allow-regress --reason` —
// writes a per-PR file under `.harness/arch/allowances/` and states plainly
// that `baselines.json stays byte-identical to the base`, then prints
// `Baseline updated successfully.` anyway. So the repo's `refresh-baseline`
// label ran a command that could not do what the label is named for, and the
// workflow's guard was widened to accept the allowance instead (#634's guard
// passes on ANY change under `.harness/arch/`, and an allowance is a new file).
//
// ## The shape of a refresh, and why it is narrow
//
// Only `metrics[<category>].value` moves. `violationIds` is left ALONE.
//
// That is the whole difference between a refresh and the wholesale behaviour
// #689 rightly refused. The aggregate ceiling is what goes stale — it is the
// number `regressionTolerance` takes its percentage of, so a floor that stops
// moving shrinks the absorber in absolute terms exactly as the repo grows
// (#736: a 5995 gap left a 1% tolerance worth 270, and 22 allowance files
// accumulated as a result). The violation identities are a different fact
// entirely: rewriting them banks every pre-existing violation as accepted and
// erases the per-PR record of who accepted what. Moving one without the other
// is both possible and correct — verified on the real repo, where a refresh in
// this shape left 1 new and 69 pre-existing violations exactly as they were.
//
// ## Why a lowered value is refused
//
// A refresh moves the floor UP to meet a reality the ratchet already tolerates.
// Moving it DOWN would widen the gate — the count is an absolute ceiling, and a
// smaller recorded value means more room before the next failure. A genuine
// improvement (the metric really did fall) should be recorded deliberately, not
// as a side effect of a label meant to accept growth, so this abstains and says
// so rather than guessing which case it is looking at.
//
// Exit codes follow the repo's gate convention (#508):
//   0 = refreshed and written
//   1 = nothing to refresh — the report was read and no metric regressed
//   2 = usage error
//   3 = ABSTENTION — the report is missing, malformed, lacks the fields this
//       needs, or asks for something that cannot be done safely. Nothing is
//       written. "I could not read the report" and "the report says there is
//       nothing to do" are different facts; collapsing them is how a refresh
//       that never ran reports success.
//
//   node scripts/refresh-arch-baseline.mjs <arch-report.json> [--baseline <path>]
//
// Produce the input with:  harness check-arch --json > arch-report.json
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASELINE = '.harness/arch/baselines.json';

const USAGE =
  'usage: refresh-arch-baseline.mjs <arch-report.json> [--baseline <path>]\n';

/** Parsed argv, or `undefined` when the invocation is unusable. */
function parseArgs(argv) {
  const positional = [];
  let baseline = DEFAULT_BASELINE;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--baseline') {
      baseline = argv[i + 1];
      if (baseline === undefined) return undefined;
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) return undefined;
  return { report: positional[0], baseline };
}

/** Reads and parses JSON, returning a tagged result rather than throwing. */
function loadJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) };
  } catch (err) {
    return { ok: false, reason: `${path}: ${err.message}` };
  }
}

/**
 * Decides what a report asks of a baseline.
 *
 * Separated from I/O so every refusal names a reason rather than being an
 * early return in the middle of a write. Deliberately NOT exported: the tests
 * drive this through the CLI, so an export would have no importer and would
 * read as dead code to the entropy detector — correctly. Returns `{status, updates?, reason?}` where status is
 * 'refresh' | 'nothing' | 'abstain'.
 */
function planRefresh(report, baseline) {
  if (!Array.isArray(report?.regressions)) {
    return {
      status: 'abstain',
      reason:
        'the report has no `regressions` array — reading an absent field as ' +
        '"nothing regressed" would fabricate a green',
    };
  }
  if (report.regressions.length === 0) {
    return { status: 'nothing' };
  }

  const metrics = baseline?.metrics;
  if (metrics === undefined || metrics === null) {
    return { status: 'abstain', reason: 'the baseline has no `metrics` object' };
  }

  const updates = [];
  for (const regression of report.regressions) {
    const category = regression?.category;
    const current = regression?.currentValue;
    if (typeof category !== 'string') {
      return { status: 'abstain', reason: 'a regression has no `category`' };
    }
    if (typeof current !== 'number' || !Number.isFinite(current)) {
      return {
        status: 'abstain',
        reason:
          `regression "${category}" carries no numeric \`currentValue\`, and ` +
          'a refresh must never invent the number it writes',
      };
    }
    const recorded = metrics[category];
    if (recorded === undefined) {
      return {
        status: 'abstain',
        reason: `the baseline records no metric "${category}"`,
      };
    }
    if (current < recorded.value) {
      return {
        status: 'abstain',
        reason:
          `"${category}" measured ${current}, below the recorded ` +
          `${recorded.value}. A refresh raises the floor to meet reality; ` +
          'lowering it would widen the gate, which needs a deliberate decision',
      };
    }
    updates.push({ category, from: recorded.value, to: current });
  }
  return { status: 'refresh', updates };
}

/** Applies the planned updates in place, touching `value` and nothing else. */
function applyRefresh(baseline, updates, { at, from } = {}) {
  for (const { category, to } of updates) {
    baseline.metrics[category].value = to;
  }
  if (at !== undefined) baseline.updatedAt = at;
  if (from !== undefined) baseline.updatedFrom = from;
  return baseline;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }

  const report = loadJson(args.report);
  if (!report.ok) {
    process.stderr.write(`abstain: cannot read the report — ${report.reason}\n`);
    return 3;
  }
  const baseline = loadJson(args.baseline);
  if (!baseline.ok) {
    process.stderr.write(
      `abstain: cannot read the baseline — ${baseline.reason}\n`,
    );
    return 3;
  }

  const plan = planRefresh(report.value, baseline.value);
  if (plan.status === 'abstain') {
    process.stderr.write(`abstain: ${plan.reason}. Nothing written.\n`);
    return 3;
  }
  if (plan.status === 'nothing') {
    process.stdout.write(
      'no metric regressed in this report, so there is nothing to refresh. ' +
        'The label was applied to a PR the arch ratchet is not failing.\n',
    );
    return 1;
  }

  const stamp = process.env.REFRESH_COMMIT;
  applyRefresh(baseline.value, plan.updates, {
    at: new Date().toISOString(),
    from: stamp === undefined || stamp === '' ? undefined : stamp,
  });
  writeFileSync(args.baseline, JSON.stringify(baseline.value, null, 2) + '\n');

  for (const { category, from, to } of plan.updates) {
    process.stdout.write(`refreshed ${category}: ${from} -> ${to}\n`);
  }
  process.stdout.write(
    'violationIds untouched — no violation was banked by this refresh.\n',
  );
  return 0;
}

// Only run when invoked directly.
// Same guard shape as `arch-verdict.mjs` — comparing resolved URLs rather than
// basenames, which would misfire on any same-named file elsewhere.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
