// budget -- run members in order inside a stated time budget (#666, spec Q3).
//
// The budget is checked before each member, not by killing one mid-flight: a
// member that would start after the budget is reported as not run, and the
// brief still renders with what finished. A member that throws becomes an
// `error` row rather than taking the run down, because the pipeline is
// advisory and a partial brief is more use than none.

/** Default wall-clock budget for the deterministic pass, in milliseconds. */
export const DEFAULT_BUDGET_MS = 5000;

const skipped = (status, reason) => ({ status, checked: 0, reason, rows: [] });

function runOne(member, ctx) {
  try {
    return member.run(ctx);
  } catch (exc) {
    return skipped('error', `member failed: ${exc?.message ?? exc}`);
  }
}

/**
 * @param {object} ctx shared run context handed to every member
 * @param {Array<{name: string, skill: string, run: Function}>} members
 * @param {{clock: () => number, budgetMs: number, start?: number}} opts
 *   `start` is when the run began (target resolution counts against the
 *   budget too); it defaults to now.
 */
export function runMembers(ctx, members, { clock, budgetMs, start = clock() }) {
  return members.map((member) => {
    const result =
      clock() - start > budgetMs
        ? skipped('budget', 'not run: time budget spent')
        : runOne(member, ctx);
    return { name: member.name, skill: member.skill, ...result };
  });
}
