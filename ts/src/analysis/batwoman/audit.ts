/**
 * One issue, audited end to end (spec Phase 4).
 *
 * The composition every surface shares: resolve the change that closed the
 * issue, probe each file it touched, and hand back the verdicts with the
 * header they belong to. It lives here rather than in the CLI so that the
 * order of operations -- and the rule that the changed-file set is the
 * denominator -- is stated once, in the analysis layer, where the Phase 5 CI
 * wrapper can reuse it without going through argv.
 *
 * **The two failure classes are deliberately different.** A closure that will
 * not resolve throws: without it there is no changed-file set, so there is no
 * denominator and nothing honest to report. A run history that will not read
 * does not throw: the denominator is known, and "could not tell" is a verdict
 * worth printing per file. Collapsing the second into the first would trade a
 * report full of abstentions for no report at all.
 */
import { resolveClosure as defaultResolveClosure } from './closure.js';
import type { Closure } from './closure.js';
import { ghRunHistory } from './gh-history.js';
import { shippedProbes } from './probes.js';
import { probeAll } from './registry.js';
import type { ExerciseVerdict, RunHistoryPort } from './verdict.js';

/** The seams a caller replaces so that no test reaches the network. */
export interface AuditDeps {
  resolveClosure(issue: number, repo: string): Promise<Closure>;
  runHistory(repo: string): RunHistoryPort;
}

/** One audited issue: the change that closed it, and a verdict per file. */
export interface Audit {
  readonly closure: Closure;
  readonly verdicts: readonly ExerciseVerdict[];
}

/**
 * Audit `issue` in `repo`, reading the working tree at `root` for static
 * resolution (which workflow calls a script, what an `on:` block says).
 */
export async function auditIssue(
  issue: number,
  repo: string,
  root: string,
  deps: Partial<AuditDeps> = {},
): Promise<Audit> {
  const resolve = deps.resolveClosure ?? defaultResolveClosure;
  const history = deps.runHistory ?? ((r: string) => ghRunHistory(r));

  const closure = await resolve(issue, repo);
  const verdicts = await probeAll(shippedProbes(), closure.files, {
    mergedAt: closure.header.mergedAt,
    repo,
    runs: history(repo),
    root,
    deleted: closure.deleted,
  });
  return { closure, verdicts };
}
