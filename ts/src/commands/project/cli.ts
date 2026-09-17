/**
 * `project` sub-app registry for `canary` (#988). Per-repo setup: skills, workflows, company knowledge.
 *
 * Rule: a new sub-app joins the domain registry it belongs to, appended where
 * it should appear in help. Each registry is capped at 12 imports by
 * ts/test/cli-command-registry.test.ts (threshold is 15); a full registry means
 * opening a new domain folder under ts/src/commands/, never growing this one.
 */

import type { Command } from 'commander';

import { buildSkillsCommand } from '../../skills-cli.js';
import { buildWorkflowCommand } from '../../workflow-cli.js';
import { buildCompanyKnowledgeCommand } from '../../company-knowledge-cli.js';
import type { MainDeps } from '../../main-deps.js';

export const PROJECT_COMMANDS: ReadonlyArray<(deps: MainDeps) => Command> = [
  (deps) => buildSkillsCommand(deps),
  (deps) => buildWorkflowCommand(deps),
  (deps) => buildCompanyKnowledgeCommand(deps),
];
