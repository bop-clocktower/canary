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

/** One file's answer. */
export interface ExerciseVerdict {
  readonly file: string;
  readonly status: ExerciseStatus;
  /** Human sentence for the report. Never a code. */
  readonly explanation: string;
  /** What was read to decide. Absent for no-probe. */
  readonly evidence?: string;
}

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
 * The single network seam (spec D6). The real implementation shells out to
 * `gh` in Phase 3; every test in Phases 1 and 2 injects a fixture.
 */
export interface RunHistoryPort {
  runsForWorkflow(workflowPath: string): Promise<WorkflowRun[]>;
}

/** Everything a probe is allowed to read. */
export interface ExerciseContext {
  readonly mergedAt: Date;
  readonly repo: string;
  readonly runs: RunHistoryPort;
  /** Repo root, for static resolution (e.g. which workflow calls a script). */
  readonly root: string;
}

/** One artifact type's detector. Shipped probes arrive in Phase 2. */
export interface ExerciseProbe {
  readonly id: string;
  /** Human noun phrase: "workflow", "workflow script". */
  readonly artifact: string;
  matches(file: string): boolean;
  probe(file: string, ctx: ExerciseContext): Promise<ExerciseVerdict>;
}
