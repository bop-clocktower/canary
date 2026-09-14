/**
 * Resolving an issue number to the change that closed it (spec Phase 4).
 *
 * GitHub closes an issue on a keyword match in a PR body. That is the fact
 * batwoman exists to question, and this module is where the questioning starts:
 * it finds the PR the keyword pointed at, when it merged, and every file it
 * touched -- the denominator the whole report is measured against.
 *
 * **Nothing here ever degrades to an empty answer.** An issue with no merged
 * closing PR, an unreachable `gh`, unparseable output, and a merged PR that
 * reports no files at all are all thrown. An empty changed-file set would
 * render as a clean report over a denominator of zero, which is a pass over
 * nothing presented as a pass -- the exact defect batwoman detects, committed
 * by batwoman.
 */
import {
  defaultSubprocess,
  type SubprocessRun,
} from '../../core/workflow-discovery.js';
import type { ClosureHeader } from './verdict.js';

/** How long to wait on one `gh` call, in seconds. */
const GH_TIMEOUT_SECONDS = 30;

/** Everything the report needs about the change that closed an issue. */
export interface Closure {
  readonly header: ClosureHeader;
  /** The pull request the closing keyword pointed at. */
  readonly pullRequest: number;
  /** Every path the PR touched, deletions included: this is the denominator. */
  readonly files: readonly string[];
  /** The subset that no longer exists (`status: "removed"`). */
  readonly deleted: ReadonlySet<string>;
}

/** Run `gh`, or throw with the reason. Never returns a degraded result. */
function gh(
  subprocess: SubprocessRun,
  args: readonly string[],
  what: string,
): unknown {
  // A throwing runner (a missing `gh`) propagates untouched: its message names
  // the real cause, and the caller reports that rather than a guess.
  const result = subprocess([...args], { timeout: GH_TIMEOUT_SECONDS });
  if (result.returncode !== 0) {
    throw new Error(
      `${what} failed (exit ${result.returncode}): ` +
        `${result.stderr.trim() || 'no stderr'}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    // Not treated as "nothing found". Unreadable output means the question
    // went unanswered, and an unanswered question is not an empty answer.
    throw new Error(`${what} returned unparseable JSON`);
  }
}

interface PrRef {
  number?: unknown;
}

/** The PR numbers GitHub records as having closed the issue. */
function closingPrNumbers(issue: number, doc: unknown): number[] {
  const refs = (doc as { closedByPullRequestsReferences?: unknown })
    ?.closedByPullRequestsReferences;
  const numbers = Array.isArray(refs)
    ? refs
        .map((r: PrRef) => r?.number)
        .filter((n): n is number => typeof n === 'number')
    : [];
  if (numbers.length === 0) {
    throw new Error(
      `issue ${issue} has no closing pull request, so there is no change to ` +
        'audit. It may have been closed by hand.',
    );
  }
  return numbers;
}

interface MergedPr {
  readonly number: number;
  readonly mergedAt: Date;
  readonly mergeSha: string;
  readonly subject: string;
}

/** One PR's merge facts, or null when it never merged. */
function readPr(
  subprocess: SubprocessRun,
  repo: string,
  number: number,
): MergedPr | null {
  const doc = gh(
    subprocess,
    [
      'gh',
      'pr',
      'view',
      '--repo',
      repo,
      String(number),
      '--json',
      'number,mergedAt,mergeCommit,title',
    ],
    `gh pr view ${number}`,
  ) as {
    mergedAt?: unknown;
    mergeCommit?: { oid?: unknown } | null;
    title?: unknown;
  };

  if (typeof doc.mergedAt !== 'string') return null;
  const mergedAt = new Date(doc.mergedAt);
  if (Number.isNaN(mergedAt.getTime())) return null;
  const oid = doc.mergeCommit?.oid;
  return {
    number,
    mergedAt,
    mergeSha: typeof oid === 'string' ? oid : '(unknown)',
    subject: typeof doc.title === 'string' ? doc.title : '(no subject)',
  };
}

/** The changed paths and the deleted subset, from the files endpoint. */
function readFiles(
  subprocess: SubprocessRun,
  repo: string,
  number: number,
): { files: string[]; deleted: Set<string> } {
  const payload = gh(
    subprocess,
    [
      'gh',
      'api',
      `repos/${repo}/pulls/${number}/files`,
      '--paginate',
      '--slurp',
    ],
    `gh api pulls/${number}/files`,
  );
  if (!Array.isArray(payload)) {
    throw new Error(`gh api pulls/${number}/files did not return a list`);
  }

  // `--paginate --slurp` yields an array of PAGES, each an array of rows --
  // verified against the live endpoint, where a single page still arrives
  // wrapped. `--jq` cannot do the flattening here: gh rejects `--slurp`
  // together with `--jq`, which a fixture-only test cannot discover because
  // the fixture never runs gh. One level is flattened, and an already-flat
  // list is accepted so the shape is not load-bearing.
  const rows = payload.every((page) => Array.isArray(page))
    ? (payload as unknown[][]).flat()
    : payload;

  const files: string[] = [];
  const deleted = new Set<string>();
  for (const row of rows as Array<{ status?: unknown; filename?: unknown }>) {
    if (typeof row?.filename !== 'string') continue;
    files.push(row.filename);
    // `status` is the only trustworthy deletion signal. An additions count of
    // zero cannot mean deleted: a file gutted to an empty stub looks identical
    // and is very much still there to run.
    if (row.status === 'removed') deleted.add(row.filename);
  }

  if (files.length === 0) {
    throw new Error(
      `pull request ${number} reports no changed files, which cannot be ` +
        'right for a merged change. Refusing to report over an empty ' +
        'denominator.',
    );
  }
  return { files, deleted };
}

/**
 * Resolve `issue` to the merged change that closed it.
 *
 * When more than one PR is recorded as closing the issue -- GitHub permits it
 * -- the most recently merged one wins. Picking by array order would make the
 * report depend on the order GitHub happened to return, and the latest merge
 * is the one whose code is actually standing in the tree.
 */
export async function resolveClosure(
  issue: number,
  repo: string,
  subprocess: SubprocessRun = defaultSubprocess,
): Promise<Closure> {
  const doc = gh(
    subprocess,
    [
      'gh',
      'issue',
      'view',
      '--repo',
      repo,
      String(issue),
      '--json',
      'number,closedByPullRequestsReferences',
    ],
    `gh issue view ${issue}`,
  );

  const candidates = closingPrNumbers(issue, doc);
  const merged = candidates
    .map((n) => readPr(subprocess, repo, n))
    .filter((pr): pr is MergedPr => pr !== null)
    .sort((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime());

  const chosen = merged[0];
  if (chosen === undefined) {
    throw new Error(
      `issue ${issue} is closed, but its closing pull request ` +
        `(${candidates.join(', ')}) was not merged, so nothing shipped to audit.`,
    );
  }

  const { files, deleted } = readFiles(subprocess, repo, chosen.number);
  return {
    header: {
      issue,
      mergeSha: chosen.mergeSha,
      mergeSubject: chosen.subject,
      mergedAt: chosen.mergedAt,
    },
    pullRequest: chosen.number,
    files,
    deleted,
  };
}
