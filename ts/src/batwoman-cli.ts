/**
 * `canary batwoman --issue N [--json]` (spec Phase 4).
 *
 * The first surface a human meets, and the point where every earlier phase is
 * wired together: the closure adapter names the change, the probes decide per
 * file, and the renderer says it in the reader's register.
 *
 * **The two output paths are not interchangeable.** The human report is
 * persona-shaped prose; `--json` is the CI wrapper's input and is
 * persona-independent, because a machine consumer's parser must not shift with
 * whoever happened to run the command. Both carry every changed file, and
 * neither carries an aggregate a reader could mistake for a pass -- `--json`
 * especially, since a convenient `passed: true` is exactly the field a CI
 * wrapper would grow later (spec criteria 2 and 3).
 *
 * A failure to resolve the closure exits non-zero and prints nothing to
 * stdout: there is no report to give. A failure to read run history does not,
 * because "could not tell" is a real verdict over a known set of files, and
 * losing the whole report to it would be worse than reporting the abstentions.
 */
import { Command, InvalidArgumentError } from 'commander';
import {
  auditIssue,
  type Audit,
  type AuditDeps,
} from './analysis/batwoman/audit.js';
import { renderReport } from './analysis/batwoman/render.js';
import { tallyVerdicts } from './analysis/batwoman/verdict.js';
import { resolvePersona, type PersonaRegistry } from './core/persona.js';
import { CliExitError } from './cli-common.js';
import type { MainDeps } from './main-deps.js';

/** The seams a test replaces so no suite reaches the network. */
export interface BatwomanCliDeps extends Partial<AuditDeps> {
  repo(): string;
  root(): string;
  /** Injected so tests never read the shipped persona registry off disk. */
  registry?: PersonaRegistry;
}

/**
 * `owner/name` for the repository under audit.
 *
 * Read from the environment GitHub Actions already sets, so the CI wrapper
 * needs no argument. Outside Actions it is required explicitly rather than
 * guessed from a git remote: a wrong repo would silently audit someone else's
 * run history and report it as this one's.
 */
function repoFromEnv(env: NodeJS.ProcessEnv): string {
  const repo = env['GITHUB_REPOSITORY'];
  if (repo === undefined || repo.trim() === '') {
    throw new Error(
      'no repository to audit: set GITHUB_REPOSITORY to "owner/name". It is ' +
        'not inferred from a git remote, because auditing the wrong ' +
        "repository's run history would report a confident answer about the " +
        'wrong thing.',
    );
  }
  return repo;
}

/** The machine shape. Deliberately flat, and deliberately without a verdict. */
function toJson({ closure, verdicts }: Audit, repo: string): string {
  const tally = tallyVerdicts(verdicts);
  return JSON.stringify(
    {
      issue: closure.header.issue,
      pullRequest: closure.pullRequest,
      repo,
      mergeSha: closure.header.mergeSha,
      mergeSubject: closure.header.mergeSubject,
      mergedAt: closure.header.mergedAt.toISOString(),
      // `changed` and `byStatus` only. There is no `assessed`, no `passed`,
      // and no score: a consumer wanting a subtotal has to add the statuses up
      // in the open, where a reviewer can see which ones it folded together.
      summary: { changed: tally.changed, byStatus: tally.byStatus },
      files: verdicts.map((v) => ({
        file: v.file,
        status: v.status,
        explanation: v.explanation,
        ...('evidence' in v && v.evidence !== undefined
          ? { evidence: v.evidence }
          : {}),
      })),
    },
    null,
    2,
  );
}

/** Build the `batwoman` subcommand. */
export function buildBatwomanCommand(
  deps: MainDeps,
  cli: Partial<BatwomanCliDeps> = {},
): Command {
  const wiring: BatwomanCliDeps = {
    repo: () => repoFromEnv(deps.env),
    root: () => deps.cwd(),
    ...cli,
  };

  const command = new Command('batwoman');
  command
    .description(
      'Report whether the files a closed issue changed have executed since ' +
        'the fix merged. Never asserts the fix is correct.',
    )
    .requiredOption('--issue <number>', 'the closed issue to audit', (raw) => {
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || n <= 0) {
        // commander's own error type, so a bad flag exits as a USAGE error
        // (2) with a clean message, rather than as an unexpected crash with a
        // stack trace in front of the user.
        throw new InvalidArgumentError(
          `--issue must be a positive integer, got "${raw}"`,
        );
      }
      return n;
    })
    .option('--json', 'emit the machine shape instead of the report')
    .action(async (opts: { issue: number; json?: boolean }) => {
      let audit: Audit;
      let repo: string;
      try {
        repo = wiring.repo();
        audit = await auditIssue(opts.issue, repo, wiring.root(), wiring);
      } catch (err) {
        // Nothing is printed to stdout: there is no report to give, and half a
        // report would be read as a whole one. Only a failure to resolve the
        // closure lands here -- an unreadable run history becomes per-file
        // abstentions inside the audit, which are worth printing.
        deps.err(err instanceof Error ? err.message : String(err));
        throw new CliExitError(1);
      }

      if (opts.json === true) {
        deps.out(toJson(audit, repo));
        return;
      }

      deps.out(
        renderReport({
          header: audit.closure.header,
          repo,
          verdicts: audit.verdicts,
          persona: resolvePersona(
            wiring.registry === undefined ? {} : { registry: wiring.registry },
          ),
        }),
      );
    });

  return command;
}
