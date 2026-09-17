#!/usr/bin/env node
// Refreshes `.harness/arch/baselines.json` from a `check-arch --json` report (#749).
//
// This exists because the CLI stopped offering a refresh: at harness 11.x+
// `check-arch --update-baseline` writes a per-PR allowance and leaves
// `baselines.json` byte-identical, while still printing success.
//
// ## The shape of a refresh, and why it is narrow
//
// Only `metrics[<category>].value` moves. `violationIds` is left ALONE.
//
// That is the whole difference from the wholesale behaviour #689 refused. The
// aggregate floor is what goes stale (#736: `regressionTolerance` is a fraction
// of it, so a stale floor shrinks the absorber). Rewriting violation identities
// would bank every pre-existing violation; moving the value alone does not —
// verified: 1 new / 69 pre-existing, identical before and after.
//
// ## Why a lowered value is refused
//
// A refresh moves the floor UP to meet what the ratchet already tolerates.
// Moving it DOWN widens the gate; a real improvement should be recorded
// deliberately, not as a side effect of a label meant to accept growth.
//
// ## Stale floors, not just regressions (#1013)
//
// `check-arch` can pass (allowances absorb the growth) while a floor sits more
// than one tolerance-width below the highest accepted allowance — what
// `ts/test/arch-baseline-freshness.test.ts` fails on. The refresh raises such a
// floor to that allowance, same narrow shape. The rule lives HERE
// (`staleFloors`) and the freshness test imports it, so they cannot disagree.
//
// Exit codes follow the repo's gate convention (#508):
//   0 = refreshed and written
//   1 = nothing to refresh — the report was read, no metric regressed, and no
//       floor is stale (the label was not needed; the workflow stays red so the
//       unnecessary opt-in is visible rather than silently spent)
//   2 = usage error
//   3 = ABSTENTION — an input is unreadable or malformed, or the refresh cannot
//       be done safely. Nothing is written. "Could not read" and "nothing to
//       do" are different facts; collapsing them fabricates a green.
//
//   node scripts/refresh-arch-baseline.mjs <arch-report.json> [--baseline <path>]
//     [--allowances <dir, default: beside baseline>] [--config <path>]
// A missing allowance dir means none; a missing config, the default tolerance.
//
// Produce the input with:  harness check-arch --json > arch-report.json
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseArgv } from 'node:util';

const DEFAULT_BASELINE = '.harness/arch/baselines.json';

/** The CLI's own default when `architecture.regressionTolerance` is unset. */
export const DEFAULT_REGRESSION_TOLERANCE = 0.01;

const USAGE =
  'usage: refresh-arch-baseline.mjs <arch-report.json> [--baseline <path>] ' +
  '[--allowances <dir>] [--config <path>]\n';

/** Parsed argv, or `undefined` when the invocation is unusable. */
function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseArgv({
      args: argv,
      allowPositionals: true,
      options: {
        baseline: { type: 'string', default: DEFAULT_BASELINE },
        allowances: { type: 'string' },
        config: { type: 'string', default: 'harness.config.json' },
      },
    });
  } catch {
    return undefined;
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 1) return undefined;
  const allowances =
    values.allowances ?? join(dirname(values.baseline), 'allowances');
  return { ...values, report: positionals[0], allowances };
}

/** Reads and parses JSON, returning a tagged result rather than throwing. */
function loadJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) };
  } catch (err) {
    return { ok: false, reason: `${path}: ${err.message}` };
  }
}

/** Highest finite allowance for `category`; undefined when none carry it. */
function highestAllowance(allowances, category) {
  const values = allowances
    .map((a) => a?.categories?.[category])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  return values.length === 0 ? undefined : Math.max(...values);
}

/**
 * Floors more than one tolerance-width below the highest accepted allowance
 * for their metric (#736, #1013). An allowance lacking a metric is skipped,
 * never read as zero; an allowance BELOW the floor is the ratchet working.
 * Returns `[{category, floor, ceiling, absorber}]`.
 */
export function staleFloors(baseline, allowances, tolerance) {
  const stale = [];
  for (const [category, recorded] of Object.entries(baseline?.metrics ?? {})) {
    const floor = recorded?.value;
    const ceiling = highestAllowance(allowances, category);
    if (typeof floor !== 'number' || ceiling === undefined) continue;
    const absorber = floor * tolerance;
    if (ceiling - floor > absorber) {
      stale.push({ category, floor, ceiling, absorber });
    }
  }
  return stale;
}

/** Every `*.json` allowance under `dir`; a missing directory is none. */
function loadAllowances(dir) {
  if (!existsSync(dir)) return { ok: true, value: [] };
  const loaded = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => loadJson(join(dir, n)));
  const bad = loaded.find((l) => !l.ok);
  return bad ?? { ok: true, value: loaded.map((l) => l.value) };
}

/** `architecture.regressionTolerance`, or the default when unset/absent. */
function loadTolerance(path) {
  if (!existsSync(path)) {
    return { ok: true, value: DEFAULT_REGRESSION_TOLERANCE };
  }
  const loaded = loadJson(path);
  if (!loaded.ok) return loaded;
  const t = loaded.value?.architecture?.regressionTolerance;
  const value = typeof t === 'number' ? t : DEFAULT_REGRESSION_TOLERANCE;
  return { ok: true, value };
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

/** Loads every input, or returns the abstention reason for the first failure. */
function loadInputs(args) {
  const inputs = {
    report: loadJson(args.report),
    baseline: loadJson(args.baseline),
    allowances: loadAllowances(args.allowances),
    tolerance: loadTolerance(args.config),
  };
  const bad = Object.entries(inputs).find(([, l]) => !l.ok);
  if (bad) return { error: `cannot read the ${bad[0]} — ${bad[1].reason}` };
  return Object.fromEntries(
    Object.entries(inputs).map(([k, l]) => [k, l.value]),
  );
}

/** Adds stale-floor lifts (#1013), judged AFTER regressions: only ever raises. */
function withStaleFloors(updates, { baseline, allowances, tolerance }) {
  const projected = applyRefresh(structuredClone(baseline), updates);
  const stale = staleFloors(projected, allowances, tolerance);
  for (const s of stale) {
    const existing = updates.find((u) => u.category === s.category);
    if (existing) existing.to = s.ceiling;
    else updates.push({ category: s.category, from: s.floor, to: s.ceiling });
  }
  return stale;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const inputs = loadInputs(args);
  const plan = inputs.error
    ? { status: 'abstain', reason: inputs.error }
    : planRefresh(inputs.report, inputs.baseline);
  if (plan.status === 'abstain') {
    process.stderr.write(`abstain: ${plan.reason}. Nothing written.\n`);
    return 3;
  }
  const updates = plan.updates ?? [];
  for (const s of withStaleFloors(updates, inputs)) {
    process.stdout.write(
      `stale floor ${s.category}: ${s.floor} is ${s.ceiling - s.floor} below ` +
        `the highest accepted allowance ${s.ceiling} (tolerance absorbs ` +
        `${s.absorber.toFixed(1)})\n`,
    );
  }
  if (updates.length === 0) {
    process.stdout.write(
      'no metric regressed and no floor is stale against the accepted ' +
        'allowances, so there is nothing to refresh. The label was applied to ' +
        'a PR neither the arch ratchet nor the freshness test is failing.\n',
    );
    return 1;
  }
  writeRefresh(args.baseline, inputs.baseline, updates);
  return 0;
}

/** Stamps, writes, and reports a refresh. */
function writeRefresh(path, baseline, updates) {
  const stamp = process.env.REFRESH_COMMIT;
  applyRefresh(baseline, updates, {
    at: new Date().toISOString(),
    from: stamp === undefined || stamp === '' ? undefined : stamp,
  });
  writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
  for (const { category, from, to } of updates) {
    process.stdout.write(`refreshed ${category}: ${from} -> ${to}\n`);
  }
  process.stdout.write(
    'violationIds untouched — no violation was banked by this refresh.\n',
  );
}

// Only run when invoked directly (resolved-URL guard, as in `arch-verdict.mjs`).
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
