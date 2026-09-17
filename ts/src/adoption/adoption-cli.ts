/**
 * `canary adoption [--dir <path>] [--branch <name>] [--json]` (#491).
 *
 * A local, read-only adoption-health report for the repo it runs in. It reads
 * guardian analysis records and local git history, prints, and exits 0. It
 * sends nothing anywhere: these numbers describe a consumer's own repository,
 * so anything leaving it would be telemetry and must be a separate, opted-in
 * decision (the `.harness/hooks/telemetry-reporter.js` consent pattern).
 *
 * The JSON shape deliberately has no `healthy` flag and no score: a consumer
 * wanting a verdict has to fold the signals together in the open.
 */

import { isAbsolute, join } from 'node:path';

import { Command } from 'commander';

import type { MainDeps } from '../main-deps.js';
import { loadRecords, scanWorkflows, type WorkflowPresence } from './load.js';
import { resolveMergeState } from './merge-state.js';
import {
  computeSignals,
  type Measured,
  type RecordSignals,
} from './signals.js';

const SCHEMA_VERSION = '1.0';

interface AdoptionReport {
  schemaVersion: string;
  egress: 'none';
  recordsDir: string;
  branch: string;
  records: {
    read: number;
    skipped: { file: string; reason: string }[];
    problem: string | null;
  };
  workflow: {
    presence: Measured<WorkflowPresence>;
    disabled: Measured<never>;
  };
  signals: RecordSignals;
}

/** `origin/HEAD`'s target when set, else `main`. */
function defaultBranch(deps: MainDeps, root: string): string {
  const res = deps.runSubprocess(
    'git',
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: root },
  );
  const name = res.status === 0 ? res.stdout.trim() : '';
  return name === '' ? 'main' : name;
}

/**
 * The repository root, so running from a subdirectory (e.g. `ts/`) still finds
 * `.github/workflows` and the default records dir. Falls back to cwd.
 */
function repoRoot(deps: MainDeps): string {
  const res = deps.runSubprocess('git', ['rev-parse', '--show-toplevel'], {
    cwd: deps.cwd(),
  });
  const top = res.status === 0 ? res.stdout.trim() : '';
  return top === '' ? deps.cwd() : top;
}

function buildReport(
  deps: MainDeps,
  opts: { dir?: string; branch?: string },
): AdoptionReport {
  const root = repoRoot(deps);
  // A default dir is repo-relative; a user-typed relative --dir is cwd-relative.
  const dirArg = opts.dir ?? join('.harness', 'analyses');
  const base = opts.dir === undefined ? root : deps.cwd();
  const dir = isAbsolute(dirArg) ? dirArg : join(base, dirArg);
  const branch = opts.branch ?? defaultBranch(deps, root);
  const { records, skipped, dirProblem } = loadRecords(dir);
  const merge = resolveMergeState(
    records.map((r) => r.ref),
    branch,
    (args) => deps.runSubprocess('git', args, { cwd: root }),
  );
  const scan = scanWorkflows(root);
  return {
    schemaVersion: SCHEMA_VERSION,
    egress: 'none',
    recordsDir: dir,
    branch,
    records: { read: records.length, skipped, problem: dirProblem },
    workflow: {
      presence:
        scan.kind === 'scanned'
          ? { status: 'measured', denominator: 1, value: scan.value }
          : { status: 'not-measured', reason: scan.reason },
      disabled: {
        status: 'not-measured',
        reason:
          'disabled state lives in the GitHub Actions API, which this report never calls',
      },
    },
    signals: computeSignals(records, merge.states, merge.problem),
  };
}

function line<T>(
  label: string,
  m: Measured<T>,
  say: (v: T, d: number) => string,
): string {
  if (m.status === 'measured')
    return `  ${label}: ${say(m.value, m.denominator)}`;
  if (m.status === 'abstained') return `  ${label}: abstained (${m.reason})`;
  return `  ${label}: not measured (${m.reason})`;
}

function headerLines(r: AdoptionReport): string[] {
  return [
    `canary adoption ${'\u{2014}'} ${r.records.read} guardian records in ${r.recordsDir} (latest run per PR), merge state from ${r.branch}`,
    ...(r.records.problem === null ? [] : [`  ${r.records.problem}`]),
    ...r.records.skipped.map((f) => `  skipped ${f.file}: ${f.reason}`),
    '',
  ];
}

function workflowLines(r: AdoptionReport): string[] {
  return [
    line('Guardian workflow', r.workflow.presence, (v) =>
      v.present
        ? `present (${v.files.join(', ')})`
        : 'absent from .github/workflows',
    ),
    line('Workflow disabled', r.workflow.disabled, () => ''),
  ];
}

function signalLines(s: RecordSignals): string[] {
  return [
    line(
      'Merged over findings',
      s.mergedWithUnaddressed,
      (v, d) =>
        `${v.withUnaddressed} of ${d} merged PRs merged with unaddressed findings (${v.unresolved} PRs unresolved, ${v.notAPr} records not a PR)`,
    ),
    line(
      'Suppressions',
      s.suppression,
      (v, d) =>
        `${v.suppressed} of ${d} findings suppressed, in ${v.recordsWithSuppression} records`,
    ),
    line(
      'Gate',
      s.gate,
      (v, d) =>
        `${Object.entries(v.byGate)
          .map(([g, n]) => `${g} ${n}`)
          .join(', ')} of ${d} runs; latest ${v.latest}`,
    ),
    line(
      'Degradation',
      s.degradation,
      (v, d) =>
        `${v.degraded} of ${d} runs degraded, ${v.abstained} abstained; tiers ${Object.entries(
          v.byTier,
        )
          .map(([t, n]) => `${t}:${n}`)
          .join(' ')}`,
    ),
    line(
      'Findings per PR',
      s.findingsPerPr,
      (v, d) =>
        `over ${d} PRs min ${v.min}, median ${v.median}, p90 ${v.p90}, max ${v.max}; ${v.over100} over 100`,
    ),
  ];
}

function renderText(r: AdoptionReport): string {
  return [
    ...headerLines(r),
    ...workflowLines(r),
    ...signalLines(r.signals),
    '',
    'Computed locally. Nothing was sent anywhere.',
  ].join('\n');
}

/** Build the `adoption` subcommand. */
export function buildAdoptionCommand(deps: MainDeps): Command {
  return new Command('adoption')
    .description(
      'Report passive adoption signals from local guardian analysis records. ' +
        'Local-only, advisory, always exits 0.',
    )
    .option(
      '--dir <path>',
      'analysis records directory (default: <repo root>/.harness/analyses)',
    )
    .option('--branch <name>', 'branch whose history decides merge state')
    .option('--json', 'emit the machine shape instead of the report')
    .action((opts: { dir?: string; branch?: string; json?: boolean }) => {
      const report = buildReport(deps, opts);
      deps.out(
        opts.json === true
          ? JSON.stringify(report, null, 2)
          : renderText(report),
      );
    });
}
