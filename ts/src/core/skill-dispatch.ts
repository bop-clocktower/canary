/**
 * Tier 2 of `canary skills run`: the dispatcher (#756).
 *
 * Canary shipped tier 1 (a skill declaring `cli:`/`entry:` is spawned) and
 * tier 3 (a prose skill is unreachable), and nothing between. 14 of canary's 21
 * skills carry no `cli:`, so no orchestrator, CI step, or sibling skill could
 * invoke them at all -- a have/have-not split that costs far more here than the
 * same split costs harness, where the dispatcher runs the CLI-less majority.
 *
 * ## What "running a prose skill" means here, honestly
 *
 * Canary is a CLI. It has no agent runtime, and it is not going to grow one to
 * close this gap. So the dispatcher does the one thing a CLI can do faithfully:
 * it RESOLVES the skill and hands back its executable contract -- identity,
 * declared runtime requirements, and the workflow text an agent is to apply --
 * with the tier and the determinism stated on the payload. The caller gets a
 * resolved, machine-readable handle to a real skill instead of exit 2.
 *
 * What it deliberately does NOT do is apply the workflow and present the result
 * as canary's. That would be canary claiming an answer it did not compute.
 *
 * ## Determinism labelling (issue design question 2)
 *
 * Every dispatch is stamped `determinism: 'agent-applied'`, against
 * `'deterministic'` for a `cli:` skill. A consumer merging findings across
 * skills must be able to tell a scanner's output from an agent's reading of a
 * ruleset; without the label the two look interchangeable, which is exactly the
 * confusion #755 documents about cassandra.
 *
 * ## Why no `--allow-executable-skills` equivalent (design question 3)
 *
 * That flag exists because a freshly cloned overlay can carry a `cli:` script,
 * and invoking it runs someone else's code on the next CI run. Dispatch runs
 * nothing: it reads a markdown file the registry already read at discovery and
 * prints it. There is no new execution to gate, so gating it would be
 * ceremony -- and ceremony that would keep the 14 skills unreachable in exactly
 * the non-interactive contexts the issue is about. The trust boundary moves to
 * whatever the caller does with the returned text, which is the caller's gate
 * to own, and the payload labels itself so the caller can see what it holds.
 *
 * ## Failure mode (design question 4)
 *
 * A skill that could not be dispatched raises {@link SkillDispatchError}. An
 * unreadable or bodyless SKILL.md is a failure, never an empty success -- a
 * dispatcher that returned "nothing to do" for a skill it could not read would
 * be indistinguishable from one that ran and found nothing.
 */

import { readFileSync } from 'node:fs';

import { errnoCode } from './gate-result.js';
import type { SkillInfo } from './skill-registry.js';

// Written as an escape so this source stays ASCII, matching gate-result.ts.
const EMDASH = '\u{2014}';

/**
 * How the results of an invocation were produced. `deterministic` is a `cli:`
 * skill's own executable; `agent-applied` is a human or agent applying a prose
 * workflow, which gives different answers on different runs.
 */
export type SkillDeterminism = 'deterministic' | 'agent-applied';

/** The resolved contract of a dispatched prose skill. */
export interface SkillDispatch {
  skill: string;
  path: string;
  /** Always `'dispatcher'` -- tier 1 never reaches this module. */
  tier: 'dispatcher';
  determinism: SkillDeterminism;
  /** True for every dispatch: canary itself applied no judgment. */
  requires_agent_runtime: boolean;
  /** Runtimes the skill declared it needs, e.g. `['node>=20']`. */
  requires: string[];
  description: string;
  /** The SKILL.md body with the frontmatter block removed. */
  instructions: string;
  /** Arguments the caller forwarded, verbatim and uninterpreted. */
  args: string[];
}

/** A dispatch that could not be completed. Never degrades to an empty result. */
export class SkillDispatchError extends Error {
  readonly skill: string;

  constructor(skill: string, message: string) {
    super(message);
    this.name = 'SkillDispatchError';
    this.skill = skill;
  }
}

/**
 * Strip a leading `---` frontmatter block, leaving the workflow prose.
 *
 * Mirrors the delimiter handling in `SkillRegistry.parseFrontmatter`: an
 * unterminated block means the whole file was frontmatter, and there is no
 * body to hand back.
 */
export function skillBody(text: string): string {
  if (!text.startsWith('---')) return text.trim();
  const rest = text.split('\n').slice(1);
  const end = rest.findIndex((l) => l.trim() === '---');
  return end === -1
    ? ''
    : rest
        .slice(end + 1)
        .join('\n')
        .trim();
}

/**
 * Resolve a prose skill into its dispatch payload.
 *
 * @throws {SkillDispatchError} when SKILL.md cannot be read, or holds no body.
 */
export function dispatchProseSkill(
  skill: SkillInfo,
  args: string[],
): SkillDispatch {
  let text: string;
  try {
    text = readFileSync(skill.path, 'utf-8');
  } catch (exc) {
    const code = errnoCode(exc);
    if (code === null) throw exc;
    throw new SkillDispatchError(
      skill.name,
      `cannot read ${skill.path} (${code}) ${EMDASH} the skill was ` +
        'discovered but its workflow could not be loaded.',
    );
  }
  const instructions = skillBody(text);
  if (!instructions) {
    throw new SkillDispatchError(
      skill.name,
      `${skill.path} carries frontmatter but no workflow body ${EMDASH} ` +
        'there is nothing to dispatch. Reporting this as an empty run would ' +
        'be indistinguishable from a skill that ran and found nothing.',
    );
  }
  return {
    skill: skill.name,
    path: skill.path,
    tier: 'dispatcher',
    determinism: 'agent-applied',
    requires_agent_runtime: true,
    requires: skill.requires,
    description: skill.description,
    instructions,
    args,
  };
}
