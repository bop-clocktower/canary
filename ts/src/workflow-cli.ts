/**
 * `canary workflow` sub-app -- faithful port of the `workflow_app` commands in
 * `agent/cli.py` (`discover`, `show`, `init`), wired to the already-ported
 * `WorkflowDiscovery` / `WorkflowMapping` / `SemanticRole`.
 *
 * `discover` is async (the discovery HTTP path returns Promises), so its handler
 * is awaited. `show` / `init` are synchronous. Ticket keys, mapping paths, and
 * the `.canary` dir all resolve from `process.cwd()` inside the injected
 * `makeWorkflowDiscovery()` factory, so a test drives them by chdir-ing.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import { CliExitError, jsonIndent2, normalizeUsageExit } from './cli-common.js';
import {
  SemanticRole,
  WorkflowDiscoveryError,
  WorkflowMapping,
} from './core/workflow-discovery.js';
import {
  CHECK,
  CROSS,
  MAGNIFIER,
  WARN,
  ELLIPSIS,
  type MainDeps,
} from './main-deps.js';

/** ISO-8601 UTC timestamp truncated to seconds (Python `isoformat(timespec)`). */
function nowIsoCli(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

interface DiscoverOptions {
  project?: string;
  refresh?: boolean;
  dryRun?: boolean;
}

async function discoverCmd(
  opts: DiscoverOptions,
  deps: MainDeps,
): Promise<void> {
  const wd = deps.makeWorkflowDiscovery();

  let keys: string[] = [];
  if (opts.project) {
    keys = [opts.project];
  } else {
    const companyPath = join(deps.cwd(), '.canary', 'company.json');
    if (existsSync(companyPath)) {
      try {
        const data = JSON.parse(readFileSync(companyPath, 'utf-8')) as {
          jira_projects?: string[];
        };
        keys = data.jira_projects ?? [];
      } catch {
        // JSONDecodeError / OSError -> leave keys empty.
      }
    }
    if (keys.length === 0) {
      deps.out(
        `${pc.yellow('No project keys found.')} Pass ${pc.bold('--project <key>')} or add keys to ${pc.bold('.canary/company.json')} ${'\u{2192}'} ${pc.bold('jira_projects')}.`,
      );
      throw new CliExitError(1);
    }
  }

  const errors: string[] = [];
  for (const key of keys) {
    deps.out(
      `\n${pc.bold(pc.cyan(`${MAGNIFIER} Discovering workflow for ${key}${ELLIPSIS}`))}`,
    );
    let mapping;
    try {
      mapping = await wd.discover(key, {
        refresh: opts.refresh ?? false,
        dryRun: opts.dryRun ?? false,
      });
    } catch (exc) {
      if (exc instanceof WorkflowDiscoveryError) {
        deps.out(`${pc.red(CROSS)} ${exc.message}`);
        errors.push(key);
        continue;
      }
      throw exc;
    }

    const nTypes = mapping.issue_types.length;
    const nRoles = Object.keys(mapping.semantic_roles).length;
    const confirmed = mapping.role_annotations_confirmed
      ? `${CHECK} confirmed`
      : `${WARN} unconfirmed`;
    if (opts.dryRun) {
      deps.out(`${pc.dim('(dry-run)')} ${mapping.toJson()}`);
    } else {
      deps.out(
        `${pc.green(CHECK)} ${key}: ${nTypes} issue type(s), ${nRoles} semantic role(s) [${confirmed}]`,
      );
      if (!mapping.role_annotations_confirmed) {
        deps.out(
          pc.dim(
            `  Tip: verify role assignments with ${pc.bold(`canary workflow show --project ${key} --roles-only`)}`,
          ),
        );
      }
    }
  }

  if (errors.length) {
    deps.out(`\n${pc.red(`Discovery failed for: ${errors.join(', ')}`)}`);
    throw new CliExitError(1);
  }
}

interface ShowOptions {
  project?: string;
  rolesOnly?: boolean;
  json?: boolean;
}

/**
 * Which project keys `show` should report on.
 *
 * `--project` names one; otherwise every cached `.canary/workflow-*.json` is
 * listed. An unreadable `.canary` yields no keys rather than throwing: a
 * missing cache is the ordinary first-run state, not an error.
 */
function resolveProjectKeys(opts: ShowOptions, deps: MainDeps): string[] {
  if (opts.project) return [opts.project];

  let keys: string[] = [];
  const canaryDir = join(deps.cwd(), '.canary');
  if (existsSync(canaryDir)) {
    try {
      keys = readdirSync(canaryDir)
        .filter((f) => f.startsWith('workflow-') && f.endsWith('.json'))
        .map((f) => f.slice('workflow-'.length, -'.json'.length));
    } catch {
      keys = [];
    }
  }
  if (keys.length === 0) {
    deps.out(pc.yellow('No cached workflow mappings found.'));
    throw new CliExitError(0);
  }
  return keys;
}

/** One mapping as JSON: the whole document, or just its semantic roles. */
function mappingAsJson(
  mapping: {
    semantic_roles: Record<string, SemanticRoleLike>;
    toJson(): string;
  },
  rolesOnly: boolean,
): string {
  if (!rolesOnly) return mapping.toJson();
  const rolesDict: Record<string, unknown> = {};
  for (const [r, sr] of Object.entries(mapping.semantic_roles)) {
    rolesDict[r] = { status_name: sr.status_name, issue_type: sr.issue_type };
  }
  return jsonIndent2(rolesDict);
}

/** The two fields `--roles-only` projects out of a semantic role. */
interface SemanticRoleLike {
  status_name: unknown;
  issue_type: unknown;
}

/** `role -> status` lines, indented under a heading. Shared by both modes. */
function printSemanticRoles(
  roles: Record<string, { status_name: unknown; issue_type: unknown }>,
  lead: string,
  deps: MainDeps,
): void {
  deps.out(`${lead}${pc.bold('Semantic roles:')}`);
  for (const [role, sr] of Object.entries(roles)) {
    deps.out(
      `    ${role.padEnd(20)} ${'\u{2192}'} '${sr.status_name}'  ${pc.dim(`(${sr.issue_type})`)}`,
    );
  }
}

/** Each issue type, its statuses, and its transitions. */
function printIssueTypes(
  issueTypes: ReadonlyArray<{
    name: string;
    statuses: ReadonlyArray<{ category: string; name: string }>;
    transitions: ReadonlyArray<{
      from_status: string;
      to_status: string;
      name: string;
    }>;
  }>,
  deps: MainDeps,
): void {
  for (const it of issueTypes) {
    deps.out(`\n  ${pc.bold(it.name)}`);
    for (const s of it.statuses) {
      deps.out(`    [${s.category}] ${s.name}`);
    }
    if (it.transitions.length === 0) continue;
    deps.out('    Transitions:');
    for (const t of it.transitions) {
      deps.out(
        `      ${t.from_status} ${'\u{2192}'} ${t.to_status}  ${pc.dim(`(${t.name})`)}`,
      );
    }
  }
}

/**
 * One cached mapping, rendered for a human.
 *
 * Extracted from `showCmd`, which had grown to hold key resolution, JSON
 * emission and this rendering at once -- and carried the semantic-roles block
 * TWICE, once per mode, which is why the two had already drifted in their
 * indentation.
 */
function printMapping(
  key: string,
  mapping: WorkflowMappingLike,
  rolesOnly: boolean,
  deps: MainDeps,
): void {
  const confirmedTag = mapping.role_annotations_confirmed
    ? pc.green('confirmed')
    : pc.yellow('unconfirmed');
  deps.out(
    `\n${pc.bold(key)}  ${pc.dim(`source=${mapping.source}  discovered=${mapping.discovered_at}  roles=${confirmedTag}`)}`,
  );

  const hasRoles = Object.keys(mapping.semantic_roles).length > 0;
  if (rolesOnly) {
    if (hasRoles) printSemanticRoles(mapping.semantic_roles, '  ', deps);
    else deps.out(`  ${pc.yellow('No semantic roles resolved yet.')}`);
    return;
  }

  printIssueTypes(mapping.issue_types, deps);
  if (hasRoles) printSemanticRoles(mapping.semantic_roles, '\n  ', deps);
}

/** The shape `show` reads off a cached mapping. */
interface WorkflowMappingLike {
  role_annotations_confirmed: boolean;
  source: unknown;
  discovered_at: unknown;
  semantic_roles: Record<string, { status_name: unknown; issue_type: unknown }>;
  issue_types: ReadonlyArray<{
    name: string;
    statuses: ReadonlyArray<{ category: string; name: string }>;
    transitions: ReadonlyArray<{
      from_status: string;
      to_status: string;
      name: string;
    }>;
  }>;
  toJson(): string;
}

function showCmd(opts: ShowOptions, deps: MainDeps): void {
  const wd = deps.makeWorkflowDiscovery();
  const keys = resolveProjectKeys(opts, deps);

  let anyFound = false;
  for (const key of keys) {
    const mapping = wd.show(key);
    if (mapping === null) {
      deps.out(
        `${pc.yellow(`No cached mapping for ${key}.`)}  Run ${pc.bold(`canary workflow discover --project ${key}`)} first.`,
      );
      continue;
    }

    anyFound = true;

    if (opts.json) {
      deps.out(mappingAsJson(mapping, opts.rolesOnly === true));
      continue;
    }

    printMapping(key, mapping, opts.rolesOnly === true, deps);
  }

  if (!anyFound) {
    throw new CliExitError(1);
  }
}

interface InitOptions {
  project: string;
  qaPassed: string;
  inQa?: string;
  atlassianUrl?: string;
  force?: boolean;
}

function initCmd(opts: InitOptions, deps: MainDeps): void {
  const wd = deps.makeWorkflowDiscovery();
  const mappingPath = wd.mappingPath(opts.project);

  if (existsSync(mappingPath) && !opts.force) {
    deps.out(
      `${pc.yellow(WARN)}  Mapping already exists at ${mappingPath}.\nUse ${pc.bold('--force')} to overwrite.`,
    );
    throw new CliExitError(1);
  }

  const resolvedUrl =
    (opts.atlassianUrl || deps.env['ATLASSIAN_URL'] || '').replace(
      /\/+$/,
      '',
    ) || null;

  const semanticRoles: Record<string, SemanticRole> = {
    qa_passed: new SemanticRole(opts.qaPassed, 'Story'),
  };
  if (opts.inQa) {
    semanticRoles['in_qa'] = new SemanticRole(opts.inQa, 'Story');
  }

  const mapping = new WorkflowMapping({
    project_key: opts.project,
    source: 'jira',
    discovered_at: nowIsoCli(),
    issue_types: [],
    semantic_roles: semanticRoles,
    role_annotations_confirmed: true,
    atlassian_url: resolvedUrl,
  });
  wd.write(mapping);

  deps.out(`${pc.green(CHECK)} Created ${mappingPath}`);
  deps.out(`  qa_passed  ${'\u{2192}'} '${opts.qaPassed}'`);
  if (opts.inQa) {
    deps.out(`  in_qa      ${'\u{2192}'} '${opts.inQa}'`);
  }
  if (resolvedUrl) {
    deps.out(`  atlassian_url ${'\u{2192}'} ${resolvedUrl}`);
  }
  deps.out(
    `\n${pc.dim(`Verify with: ${pc.bold(`canary workflow show --project ${opts.project} --roles-only`)}`)}`,
  );
}

/** Build the `workflow` sub-app wired to `deps`. */
export function buildWorkflowCommand(deps: MainDeps): Command {
  const program = new Command('workflow');
  program
    .description('Discover and inspect per-project issue-workflow mappings.')
    .exitOverride(normalizeUsageExit);

  program
    .command('discover')
    .description(
      'Discover the Jira or GitHub workflow for one or more projects and persist the mapping.',
    )
    .option(
      '-p, --project <project>',
      'Jira project key or GitHub repo slug. Defaults to company.json jira_projects.',
    )
    .option('--refresh', 'Re-discover even if a cached mapping already exists.')
    .option(
      '--dry-run',
      'Print the mapping that would be written without writing it.',
    )
    .action(async (opts: DiscoverOptions) => {
      await discoverCmd(opts, deps);
    });

  program
    .command('show')
    .description('Print the persisted workflow mapping for a project.')
    .option(
      '-p, --project <project>',
      'Jira project key or GitHub repo slug. Shows all cached mappings if omitted.',
    )
    .option('--roles-only', 'Print only the semantic_roles block.')
    .option('--json', 'Emit raw JSON instead of styled output.')
    .action((opts: ShowOptions) => {
      showCmd(opts, deps);
    });

  program
    .command('init')
    .description(
      'Create a minimal workflow mapping for a project without running discovery.',
    )
    .requiredOption('-p, --project <project>', 'Jira project key (e.g. ACME).')
    .requiredOption(
      '--qa-passed <status>',
      'Exact Jira status name that means QA passed.',
    )
    .option('--in-qa <status>', "Exact Jira status name for 'in QA'. Optional.")
    .option('--atlassian-url <url>', 'Jira base URL for this project.')
    .option('--force', 'Overwrite an existing mapping file.')
    .action((opts: InitOptions) => {
      initCmd(opts, deps);
    });

  for (const sub of program.commands) {
    sub.exitOverride(normalizeUsageExit);
  }

  return program;
}
