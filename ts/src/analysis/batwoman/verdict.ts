/**
 * canary-batwoman's verdict model (spec `docs/changes/canary-batwoman/`).
 *
 * Batwoman answers one question per changed file -- has this artifact executed
 * since the fix merged -- and answers with one of five values, never with a
 * confidence score. A score attached to a guess reads as evidence; "I have no
 * probe for this" does not (spec D4).
 *
 * `abstain` and `no-probe` are deliberately separate. The first means a probe
 * looked and could not tell: report it, investigate it. The second means
 * nothing looked: a registry gap, fixable by adding a probe. Collapsing them
 * would hide which of the two a given file suffers from (spec D3).
 */

/** The five statuses, in report order. */
export const EXERCISE_STATUSES = [
  'exercised',
  'not-exercised',
  'abstain',
  'no-probe',
  'not-applicable',
] as const;

export type ExerciseStatus = (typeof EXERCISE_STATUSES)[number];

/** The two statuses that make a positive claim about whether the file ran. */
export const CLAIMING_STATUSES = ['exercised', 'not-exercised'] as const;

export type ClaimingStatus = (typeof CLAIMING_STATUSES)[number];

/** The three named non-answers: nothing was claimed, so nothing is owed. */
export type NonAnswerStatus = Exclude<ExerciseStatus, ClaimingStatus>;

declare const explanationBrand: unique symbol;

/**
 * A verdict sentence that is guaranteed non-empty, by construction.
 *
 * Branded rather than a bare `string` so that the only way to obtain one is
 * {@link explain}. An empty explanation used to render as a bare file path
 * under a status heading -- a row that names a file and says nothing about it,
 * which is the shape spec criterion 11 forbids. Detecting that downstream was
 * rejected in review: the renderer would then be responsible for a defect it
 * cannot fix, and a probe could still ship the gap. Making it unrepresentable
 * moves the failure to the one place that can do something about it.
 */
export type Explanation = string & { readonly [explanationBrand]: true };

/** Thrown by {@link explain}. Named so a probe's failure reads as its own. */
export class EmptyExplanationError extends Error {
  constructor() {
    super(
      'an ExerciseVerdict explanation must be a full sentence, never empty: ' +
        'a row that names a file and says nothing about it is the silence ' +
        'batwoman exists to remove',
    );
    this.name = 'EmptyExplanationError';
  }
}

/** True when `text` could be an {@link Explanation}. Whitespace is not a sentence. */
export function isExplanation(text: unknown): text is Explanation {
  return typeof text === 'string' && text.trim() !== '';
}

/** The only constructor for an {@link Explanation}. Rejects the empty string. */
export function explain(text: string): Explanation {
  if (!isExplanation(text)) throw new EmptyExplanationError();
  return text;
}

interface VerdictFields {
  readonly file: string;
  /** Human sentence for the report. Never a code, never empty. */
  readonly explanation: Explanation;
}

/**
 * A verdict that claims the file did or did not run, and names what it read.
 *
 * `evidence` is required here and optional below. A success claim with nothing
 * behind it is precisely the defect batwoman exists to detect, so permitting
 * one in batwoman's own model would be self-undermining -- and `not-exercised`
 * is held to the same bar, because a negative claim sends a human to run
 * something and deserves to say why.
 */
export interface ClaimedVerdict extends VerdictFields {
  readonly status: ClaimingStatus;
  /** What was read to decide. Required: a claim must name its source. */
  readonly evidence: string;
}

/** A verdict that claims nothing: `abstain`, `no-probe` or `not-applicable`. */
export interface UnclaimedVerdict extends VerdictFields {
  readonly status: NonAnswerStatus;
  /** What was read, when anything was. Absent for `no-probe` by definition. */
  readonly evidence?: string;
}

/** One file's answer. */
export type ExerciseVerdict = ClaimedVerdict | UnclaimedVerdict;

/** Header data for the report. Probes never read this. */
export interface ClosureHeader {
  readonly issue: number;
  readonly mergeSha: string;
  readonly mergeSubject: string;
  readonly mergedAt: Date;
}

/** One GitHub Actions run, reduced to the two fields a probe decides on. */
export interface WorkflowRun {
  readonly createdAt: Date;
  readonly conclusion: string | null;
}

/**
 * One fetched window of a workflow's run history.
 *
 * `complete` is the field that keeps batwoman honest about its own reach.
 * `gh run list` paginates, so a page that filled to its limit may have older
 * runs behind it. If that window never got back past the merge, then "no run
 * after the merge" and "I stopped looking" are the same observation, and only
 * one of them is a verdict. The port reports what it saw; the probe decides
 * what that is worth (spec Phase 3).
 */
export interface RunHistory {
  readonly runs: readonly WorkflowRun[];
  /** False when the page hit its limit -- older runs may exist behind it. */
  readonly complete: boolean;
}

/**
 * The single network seam (spec D6). The real implementation shells out to
 * `gh` (see `gh-history.ts`); every probe test injects a fixture.
 */
export interface RunHistoryPort {
  runsForWorkflow(workflowPath: string): Promise<RunHistory>;
}

/** Everything a probe is allowed to read. */
export interface ExerciseContext {
  readonly mergedAt: Date;
  readonly repo: string;
  readonly runs: RunHistoryPort;
  /** Repo root, for static resolution (e.g. which workflow calls a script). */
  readonly root: string;
  /**
   * Paths the closing PR deleted.
   *
   * A deleted file has nothing left to execute and no longer exists to
   * classify, so it is answered before any probe is consulted (spec Phase 3).
   */
  readonly deleted: ReadonlySet<string>;
}

/** One artifact type's detector. The shipped three live in `probes.ts`. */
export interface ExerciseProbe {
  readonly id: string;
  /** Human noun phrase: "workflow", "workflow script". */
  readonly artifact: string;
  matches(file: string): boolean;
  probe(file: string, ctx: ExerciseContext): Promise<ExerciseVerdict>;
}

/** One count per status. No aggregate: see {@link tallyVerdicts}. */
export type StatusTally = Readonly<Record<ExerciseStatus, number>>;

/** The report's denominator, plus its parts. */
export interface Tally {
  readonly changed: number;
  readonly byStatus: StatusTally;
}

/**
 * Count verdicts by status.
 *
 * There is deliberately no `assessed` field. A derived "files batwoman could
 * decide about" figure is exactly the shape spec criterion 3 forbids: it makes
 * `abstain` and `no-probe` disappear into a denominator that looks like
 * coverage. A caller wanting a subtotal has to write the addition itself, in
 * the open, where a reviewer can see which statuses it folded.
 */
export function tallyVerdicts(verdicts: readonly ExerciseVerdict[]): Tally {
  const byStatus: Record<ExerciseStatus, number> = {
    exercised: 0,
    'not-exercised': 0,
    abstain: 0,
    'no-probe': 0,
    'not-applicable': 0,
  };
  for (const verdict of verdicts) byStatus[verdict.status] += 1;
  return { changed: verdicts.length, byStatus };
}
