/** `canary evidence export` (#855): advisory; lists evidence and never grades it. Own folder so the filename binds the `cli` layer. */

import { Command } from 'commander';

import { exportPack } from '../analysis/evidence/pack.js';
import { ciReadyReportFor } from '../ci-ready-cli.js';
import { CliExitError, normalizeUsageExit } from '../cli-common.js';

/** The seams this command uses; `MainDeps` satisfies it. */
interface Deps {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  cwd(): string;
  runSubprocess(cmd: string, args: string[], opts: { cwd: string }): Git;
}

type Git = { status: number | null; stdout: string };

type ExportOpts = Record<string, string | undefined> & { since: string };

/** A bare date is midnight UTC; a date-time must carry its zone, so a window means the same on every machine. */
const ISO =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

function fail(deps: Deps, exit: number, lines: string[]): never {
  for (const line of lines) deps.err(line);
  throw new CliExitError(exit);
}

function instant(deps: Deps, flag: string, raw: string): string {
  const ms = ISO.test(raw) ? Date.parse(raw) : NaN;
  const bad = `evidence: ${flag} ${raw} is not an ISO 8601 date`;
  return Number.isNaN(ms) ? fail(deps, 2, [bad]) : new Date(ms).toISOString();
}

function runExport(deps: Deps, opts: ExportOpts, at: string): void {
  const { batwoman, out, root = deps.cwd() } = opts;
  const since = instant(deps, '--since', opts.since);
  const until = opts.until ? instant(deps, '--until', opts.until) : at;
  const order = `evidence: --since ${since} is not before ${until}`;
  if (since >= until) fail(deps, 2, [order]);
  const git = deps.runSubprocess('git', ['rev-parse', 'HEAD'], { cwd: root });
  const sha = git.stdout.trim();
  const commit = git.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  const repo = opts.repo || deps.env['GITHUB_REPOSITORY'] || undefined;
  const scope = { since, until, root, out, at, commit, repo, batwoman };
  const done = exportPack(scope, () => ciReadyReportFor(root));
  if (done.exit !== 0) fail(deps, done.exit, done.lines);
  for (const line of done.lines) deps.out(line);
}

export function buildEvidenceCommand(
  deps: Deps,
  now: () => Date = () => new Date(),
): Command {
  const command = new Command('evidence');
  command.description('Audit evidence: lists what ran, never grades it.');
  command
    .command('export')
    .description('Write a control-mapped evidence pack for a time window.')
    .requiredOption('--since <date>', 'Start: ISO date or zoned date-time.')
    .option('--until <date>', 'End, exclusive (default: now).')
    .option('--root <dir>', 'Repository root (default: cwd).')
    .option('--batwoman <dir>', 'Saved `canary batwoman --json` reports.')
    .option('--out <dir>', 'Output directory (default: .canary/evidence).')
    .option('--repo <owner/name>', 'Repository for commit URLs.')
    .exitOverride(normalizeUsageExit)
    .action((opts: ExportOpts) => runExport(deps, opts, now().toISOString()));
  return command;
}
