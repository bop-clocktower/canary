// brief -- one run of the pipeline: resolve the target, run the members inside
// the budget, assemble the brief and format it (#666). Kept apart from the CLI
// so each module imports only a handful of others (the perf ratchet's
// coupling rule).

import { resolveTarget } from './target.mjs';
import { runMembers } from './budget.mjs';
import { MEMBERS } from './members.mjs';
import {
  ABSTAINED_LINE,
  buildBrief,
  renderJson,
  renderMarkdown,
} from './render.mjs';

/**
 * @param {{repo: string, paths: string[], budgetMs: number, json: boolean}} opts
 * @param {{clock: () => number, cwd: string}} deps
 * @returns {{brief: object, text: string, alert: string|null}}
 *   `alert` is the abstained line for stderr, or null when nothing abstained.
 */
export function produce(opts, { clock, cwd }) {
  const start = clock();
  const target = resolveTarget({ repo: opts.repo, paths: opts.paths, cwd });
  const ctx = { root: target.root, files: target.files };
  const members = target.abstain
    ? []
    : runMembers(ctx, MEMBERS, { clock, budgetMs: opts.budgetMs, start });
  const brief = buildBrief({
    target,
    members,
    budgetMs: opts.budgetMs,
    elapsedMs: Math.round(clock() - start),
  });
  return {
    brief,
    text: opts.json ? renderJson(brief) : renderMarkdown(brief),
    alert: brief.abstained ? `${ABSTAINED_LINE} ${brief.reason}` : null,
  };
}
