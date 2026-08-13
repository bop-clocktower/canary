/**
 * `canary company-knowledge` sub-app -- faithful port of the `ck_app` commands
 * in `agent/cli.py` (`show` + `init`). `init` is exported as {@link ckInitCmd}
 * so the top-level `setup` alias can call it directly (Python `setup` -> `ck_init`).
 *
 * The interactive `init` wizard reads through {@link MainDeps.prompt} (typer.prompt
 * analog); the production default reads piped stdin lines and falls back to the
 * shown default, so a non-interactive/CI invocation keeps existing values.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command, Option } from 'commander';
import pc from 'picocolors';

import { CliExitError, jsonIndent2, normalizeUsageExit } from './cli-common.js';
import { CompanyKnowledge } from './core/company-knowledge.js';
import { CHECK, CROSS, WARN, type MainDeps } from './main-deps.js';

interface ShowOptions {
  env?: string;
  json?: boolean;
}

function ckShowCmd(opts: ShowOptions, deps: MainDeps): void {
  const ck = deps.loadCompanyKnowledge(opts.env ?? null);

  if (ck.error && ck.isEmpty) {
    deps.out(`${pc.red(CROSS)} ${ck.error}`);
    throw new CliExitError(1);
  }

  if (opts.json) {
    deps.out(jsonIndent2(ck.toDict()));
    return;
  }

  if (ck.isEmpty) {
    deps.out(
      `${pc.yellow('No company knowledge configured.')}  Create ${pc.bold('.canary/company.json')} or run ${pc.bold('canary company-knowledge init')}.`,
    );
    return;
  }

  const sourcesStr = ck.sources.length ? ck.sources.join(', ') : 'none';
  deps.out(
    `${pc.bold(pc.green(`${CHECK} Company Knowledge`))}  ${pc.dim(`sources: ${sourcesStr}`)}\n`,
  );
  if (ck.confluence_spaces.length) {
    deps.out(
      `${pc.bold('Confluence spaces:')} ${ck.confluence_spaces.join(', ')}`,
    );
  }
  if (ck.jira_projects.length) {
    deps.out(`${pc.bold('Jira projects:')}     ${ck.jira_projects.join(', ')}`);
  }
  if (ck.internal_doc_urls.length) {
    deps.out(pc.bold('Reference docs:'));
    for (const url of ck.internal_doc_urls) deps.out(`  ${url}`);
  }
  if (ck.internal_domains.length) {
    deps.out(
      `${pc.bold('Internal domains:')}  ${ck.internal_domains.join(', ')}`,
    );
  }
  if (ck.mcp_servers.length) {
    deps.out(`${pc.bold('MCP servers:')}       ${ck.mcp_servers.join(', ')}`);
  }
  if (ck.claude_code_skills.length) {
    deps.out(
      `${pc.bold('Claude Code skills:')} ${ck.claude_code_skills.join(', ')}`,
    );
  }
  if (ck.dashboard_url) {
    deps.out(`${pc.bold('Dashboard URL:')}     ${ck.dashboard_url}`);
  }
  if (ck.otel_exporter_endpoint) {
    deps.out(`${pc.bold('OTel endpoint:')}     ${ck.otel_exporter_endpoint}`);
  }
  if (ck.notes) {
    deps.out(`${pc.bold('Notes:')} ${ck.notes}`);
  }
  if (!ck.brand.isEmpty) {
    const label =
      (ck.brand.assets['company_name'] as string | undefined) || '(unnamed)';
    deps.out(
      `${pc.bold('Brand:')}            ${label}  ${pc.dim('(customer-facing reports)')}`,
    );
  }
  if (ck.error) {
    deps.out(`\n${pc.yellow(WARN)} ${ck.error}`);
  }
  if (ck.warnings.length) {
    deps.out('');
    for (const w of ck.warnings) deps.out(`${pc.yellow(WARN)} ${w}`);
  }
}

interface InitOptions {
  force?: boolean;
}

/**
 * Interactive `.canary/company.json` wizard. Exported so `setup` can alias it.
 */
export function ckInitCmd(opts: InitOptions, deps: MainDeps): void {
  const canaryDir = join(deps.cwd(), '.canary');
  const outPath = join(canaryDir, 'company.json');

  // Existing values become the shown defaults (load() returns empty when absent).
  const existing = CompanyKnowledge.load(deps.cwd(), null, deps.home());

  if (existsSync(outPath) && !opts.force) {
    deps.out(
      `${pc.yellow(WARN)}  ${pc.bold(outPath)} already exists.\nExisting values will be shown as defaults. Pass ${pc.bold('--force')} to start from scratch.`,
    );
    deps.out('');
  }

  const promptList = (
    label: string,
    current: string[],
    hint = '',
  ): string[] => {
    const defaultStr = current.join(', ');
    const displayDefault = defaultStr ? ` [${defaultStr}]` : '';
    const text = `${label}${displayDefault} (comma-separated${hint ? ', ' + hint : ''}): `;
    const raw = deps.prompt(text, defaultStr);
    if (!raw.trim()) return current;
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v);
  };

  const promptStr = (label: string, current: string, hint = ''): string => {
    const displayDefault = current ? ` [${current}]` : '';
    const text = `${label}${displayDefault}${hint ? ` (${hint}): ` : ': '}`;
    return deps.prompt(text, current).trim();
  };

  deps.out(pc.bold(pc.cyan('Canary Company Knowledge Setup')) + '\n');
  deps.out(
    'Enter values for each pointer field, or press Enter to keep the current value.',
  );
  deps.out(
    `Leave a field empty to skip it. ${pc.dim('Secrets are never accepted here.')}\n`,
  );

  const confluenceSpaces = promptList(
    'Confluence space keys',
    existing.confluence_spaces,
    'uppercase, e.g. QA',
  );
  const jiraProjects = promptList(
    'Jira project keys',
    existing.jira_projects,
    'uppercase, e.g. PROJ',
  );

  deps.out('\nInternal doc URLs (one per line, blank line to finish):');
  const docUrls: string[] = [...existing.internal_doc_urls];
  if (docUrls.length) deps.out(`  Current: ${docUrls.join(', ')}`);
  for (;;) {
    const url = deps.prompt('  URL (or Enter to finish)', '');
    if (!url.trim()) break;
    docUrls.push(url.trim());
  }

  const internalDomains = promptList(
    '\nInternal hostnames',
    existing.internal_domains,
    'e.g. corp.example.com',
  );
  const mcpServers = promptList(
    'MCP server identifiers',
    existing.mcp_servers,
    'e.g. plugin_atlassian_atlassian',
  );
  const claudeCodeSkills = promptList(
    'Claude Code skill slugs',
    existing.claude_code_skills,
    'e.g. team:skill-name',
  );
  const notesRaw = promptStr(
    '\nFree-text notes for the LLM',
    existing.notes,
    'no secrets',
  );
  const notes = notesRaw ? notesRaw.slice(0, 2048) : '';

  deps.out(
    `\n${pc.bold('Brand assets')} ${pc.dim('(for customer-facing reports; all optional)')}`,
  );
  const existingBrand = existing.brand.assets;
  const brand: Record<string, unknown> = { ...existingBrand };
  const ba = (k: string): string =>
    (existingBrand[k] as string | undefined) ?? '';
  const prompted: Record<string, string> = {
    company_name: promptStr(
      'Company name',
      ba('company_name'),
      'e.g. Acme Corp',
    ),
    logo_path: promptStr(
      'Logo path (in-repo)',
      ba('logo_path'),
      'e.g. assets/logo.svg',
    ),
    logo_url: promptStr('Logo URL (if hosted)', ba('logo_url'), 'https://...'),
    primary_color: promptStr('Primary color', ba('primary_color'), '#RRGGBB'),
    secondary_color: promptStr(
      'Secondary color',
      ba('secondary_color'),
      '#RRGGBB',
    ),
    text_color: promptStr('Text color', ba('text_color'), '#RRGGBB'),
    background_color: promptStr(
      'Background color',
      ba('background_color'),
      '#RRGGBB',
    ),
    footer_note: promptStr(
      'Report footer note',
      ba('footer_note'),
      'e.g. Acme QA report',
    ),
  };
  for (const [k, v] of Object.entries(prompted)) {
    if (v) brand[k] = v;
  }

  const out: Record<string, unknown> = {};
  if (confluenceSpaces.length) {
    out['confluence_spaces'] = confluenceSpaces.map((v) => v.toUpperCase());
  }
  if (jiraProjects.length) {
    out['jira_projects'] = jiraProjects.map((v) => v.toUpperCase());
  }
  if (docUrls.length) out['internal_doc_urls'] = docUrls;
  if (internalDomains.length) {
    out['internal_domains'] = internalDomains.map((v) => v.toLowerCase());
  }
  if (mcpServers.length) out['mcp_servers'] = mcpServers;
  if (claudeCodeSkills.length) {
    out['claude_code_skills'] = claudeCodeSkills.map((v) => v.toLowerCase());
  }
  if (notes) out['notes'] = notes;
  if (Object.keys(brand).length) out['brand'] = brand;

  mkdirSync(canaryDir, { recursive: true });

  const gitignore = join(deps.cwd(), '.gitignore');
  if (existsSync(gitignore)) {
    const content = readFileSync(gitignore, 'utf-8');
    if (!content.includes('.canary/')) {
      writeFileSync(
        gitignore,
        content.replace(/\s+$/, '') + '\n.canary/\n',
        'utf-8',
      );
    }
  }

  writeFileSync(outPath, jsonIndent2(out) + '\n', 'utf-8');

  deps.out(`\n${pc.green(CHECK)} Written to ${pc.bold(outPath)}`);
  deps.out(pc.dim('Verify with: canary company-knowledge show'));
}

/** Build the `company-knowledge` sub-app wired to `deps`. */
export function buildCompanyKnowledgeCommand(deps: MainDeps): Command {
  const program = new Command('company-knowledge');
  program
    .description('Manage company-knowledge pointers in .canary/company.json.')
    .exitOverride(normalizeUsageExit);

  program
    .command('show')
    .description('Print the merged company-knowledge view.')
    .option(
      '-e, --env <env>',
      "Environment override layer to load (e.g. 'uat'). Defaults to CANARY_ENV.",
    )
    .option('--json', 'Emit raw JSON.')
    .action((opts: ShowOptions) => {
      ckShowCmd(opts, deps);
    });

  program
    .command('init')
    .description('Interactively scaffold .canary/company.json.')
    .addOption(
      new Option('--force', 'Overwrite an existing .canary/company.json.'),
    )
    .action((opts: InitOptions) => {
      ckInitCmd(opts, deps);
    });

  for (const sub of program.commands) {
    sub.exitOverride(normalizeUsageExit);
  }

  return program;
}
