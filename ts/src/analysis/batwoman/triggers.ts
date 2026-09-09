/**
 * Turning a workflow's `on:` block into the clause that explains its dormancy.
 *
 * This exists because of the founding case. #749 fixed
 * `refresh-arch-baseline.yml`, and that workflow had not run in twelve days --
 * not because anything was broken, but because it is gated on a label nobody
 * had applied. A report that says only "has not run" sends its reader to look
 * for a break that is not there, and the time they lose is time batwoman
 * caused. The trigger is the difference between a fact and an explanation.
 *
 * **Unrecognised shapes return `null`, never a guess.** The probe degrades to
 * the bare run-history sentence when that happens. Inventing a plausible
 * trigger would put a fabricated cause into a human's report, which is a worse
 * failure than saying less: a wrong cause is acted on, silence is asked about.
 */

/** Trigger names worth explaining, mapped to the clause each contributes. */
const SIMPLE_CLAUSES: Readonly<Record<string, string>> = {
  push: 'on push',
  pull_request: 'on a pull request',
  pull_request_target: 'on a pull request',
  workflow_dispatch: 'manually',
  workflow_call: 'when another workflow calls it',
  schedule: 'on a schedule',
  release: 'on a release',
  issues: 'on issue activity',
  issue_comment: 'on an issue comment',
};

/**
 * Triggers that mean "this sits still until a human does something specific".
 *
 * Only these earn the word "only", and only when they stand alone: a workflow
 * that also runs on push is not dormant, and calling it dormant would be the
 * same fabrication this module refuses elsewhere.
 */
const DORMANT_ALONE = new Set(['workflow_dispatch', 'pull_request_labeled']);

/** The `on:` block's keys, from either the mapping or the bare-list form. */
function triggerNames(on: unknown): string[] {
  if (Array.isArray(on))
    return on.filter((n): n is string => typeof n === 'string');
  if (typeof on === 'object' && on !== null) return Object.keys(on);
  return [];
}

/** The config a trigger carries, or undefined for the bare-list form. */
function configFor(on: unknown, name: string): unknown {
  if (typeof on === 'object' && on !== null && !Array.isArray(on)) {
    return (on as Record<string, unknown>)[name];
  }
  return undefined;
}

/** `{ types: ['labeled'] }` -> true. The shape #749's workflow uses. */
function isLabelGated(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false;
  const types = (config as { types?: unknown }).types;
  return Array.isArray(types) && types.length === 1 && types[0] === 'labeled';
}

/** `{ branches: ['main'] }` -> 'main'. Multiple branches are not enumerated. */
function branchClause(config: unknown): string {
  if (typeof config !== 'object' || config === null) return '';
  const branches = (config as { branches?: unknown }).branches;
  if (!Array.isArray(branches) || branches.length !== 1) return '';
  const only = branches[0];
  return typeof only === 'string' ? ` to ${only}` : '';
}

/** One trigger's clause, or null when it is not one we explain. */
function clauseFor(name: string, config: unknown): string | null {
  if (name === 'pull_request' && isLabelGated(config)) {
    return 'when a label is added to a pull request';
  }
  const base = SIMPLE_CLAUSES[name];
  if (base === undefined) return null;
  return name === 'push' ? `${base}${branchClause(config)}` : base;
}

/** The key a clause was derived from, for the dormancy test. */
function dormancyKey(name: string, config: unknown): string {
  return name === 'pull_request' && isLabelGated(config)
    ? 'pull_request_labeled'
    : name;
}

/**
 * A human clause naming why a workflow runs -- `triggered on push to main`,
 * `triggered only when a label is added to a pull request`.
 *
 * Returns `null` when the block is absent, malformed, or names only events
 * this module has no wording for. The caller must handle null by saying less,
 * not by filling in.
 */
export function describeTriggers(on: unknown): string | null {
  const names = triggerNames(on);
  if (names.length === 0) return null;

  const clauses: string[] = [];
  const keys: string[] = [];
  // Manual dispatch reads last regardless of where it sat in the YAML. Key
  // order is an authoring accident -- the same workflow written two ways would
  // otherwise produce two different sentences -- and "or manually" is the
  // afterthought clause in English anyway.
  const ordered = [...names].sort(
    (a, b) =>
      Number(a === 'workflow_dispatch') - Number(b === 'workflow_dispatch'),
  );
  for (const name of ordered) {
    const config = configFor(on, name);
    const clause = clauseFor(name, config);
    // An unrecognised event is skipped rather than echoed: printing
    // `triggered on some_future_event` would read as an explanation while
    // telling the reader nothing they did not already see in the file.
    if (clause === null) continue;
    clauses.push(clause);
    keys.push(dormancyKey(name, config));
  }
  if (clauses.length === 0) return null;

  const only =
    clauses.length === 1 && keys[0] !== undefined && DORMANT_ALONE.has(keys[0]);
  const joined =
    clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(', ')}, or ${clauses[clauses.length - 1]}`;

  return `triggered ${only ? 'only ' : ''}${joined}`;
}
