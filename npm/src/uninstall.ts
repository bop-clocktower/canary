/**
 * `canary uninstall` — remove what the CLI can safely remove, and print
 * instructions for what it structurally cannot.
 *
 * The command deliberately refuses to claim more than it did. A full install
 * scatters artifacts across seven locations (#523) and two of them belong to
 * other owners: the CLI binary (the running process, removed by whichever
 * package manager installed it) and the Claude Code plugin registration
 * (`installed_plugins.json`, mutated only by `/plugin uninstall`). Reporting
 * those as done would be the same false-green shape the guardian exists to
 * catch, so they render as `manual` and are never passed to the removal path.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as registry from './overlays-registry.js';
import { enumerate } from './uninstall-scan.js';
import { render } from './uninstall-render.js';
import {
  MCP_KEY,
  type Artifact,
  type Scope,
  type UninstallDeps,
} from './uninstall-types.js';

export { enumerate } from './uninstall-scan.js';
export { render } from './uninstall-render.js';
export type {
  Artifact,
  Disposition,
  EnumerateOptions,
  Scope,
  UninstallDeps,
} from './uninstall-types.js';

function removeCanaryDir(dir: string, keepQuarantine: boolean): void {
  if (!keepQuarantine) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  for (const child of fs.readdirSync(dir)) {
    if (child === 'quarantine.json') continue;
    fs.rmSync(path.join(dir, child), { recursive: true, force: true });
  }
}

function removeMcpEntry(file: string): void {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  if (doc.mcpServers) delete doc.mcpServers[MCP_KEY];
  // Two-space JSON matches what the ecosystem writes; the file is left in
  // place even when `mcpServers` is now empty — deciding an empty config
  // should not exist is the user's call.
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

export interface RemovalOutcome {
  removed: Artifact[];
  failed: Array<{ artifact: Artifact; error: string }>;
}

/** Delete one artifact. Assumes the caller already checked `removable`. */
function removeOne(
  artifact: Artifact,
  home: string,
  keepQuarantine: boolean,
): void {
  const target = artifact.path;
  if (!target) return;

  if (artifact.kind === 'mcp-entry') {
    removeMcpEntry(target);
    return;
  }
  if (artifact.kind === 'project-config') {
    removeCanaryDir(target, keepQuarantine);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  if (artifact.kind === 'overlay') {
    // The clone is gone; drop its registry row too, or `overlay list` keeps
    // advertising a path that no longer exists.
    const name = artifact.label.replace(/^overlay /, '');
    registry.write(registry.remove(registry.read(home), name).registry, home);
  }
}

export function removeAll(
  artifacts: Artifact[],
  deps: UninstallDeps = {},
): RemovalOutcome {
  const home = deps.homeDir ?? os.homedir();
  const outcome: RemovalOutcome = { removed: [], failed: [] };
  // When the ledger was withheld, `.canary/` must be emptied around it rather
  // than deleted wholesale — otherwise the removal silently undoes the
  // protection the `blocked` disposition just promised.
  const keepQuarantine = artifacts.some(
    (a) => a.kind === 'quarantine-ledger' && a.disposition === 'blocked',
  );

  for (const a of artifacts) {
    if (a.disposition !== 'removable') continue;
    try {
      removeOne(a, home, keepQuarantine);
      outcome.removed.push(a);
    } catch (e) {
      outcome.failed.push({ artifact: a, error: (e as Error).message });
    }
  }
  return outcome;
}

const KNOWN_FLAGS = new Set([
  '--global',
  '--project',
  '--all',
  '--apply',
  '--include-generated',
]);

/** The scope menu, shared by `--help` and the no-scope refusal. */
const SCOPE_HELP =
  '  --global   overlays and orphaned Claude Code plugin caches\n' +
  '  --project  .canary/, generated reports, and the .mcp.json entry\n' +
  '  --all      both\n' +
  'Nothing is removed without --apply.\n';

export function run(argv: readonly string[], deps: UninstallDeps = {}): number {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;

  // Routed before the engine's commander sees argv (#730), so `--help` lands
  // here as a plain token. Asking how a command works is not a usage error.
  if (argv.includes('--help') || argv.includes('-h')) {
    out.write(`usage: canary uninstall <scope> [--apply]\n${SCOPE_HELP}`);
    return 0;
  }

  for (const a of argv) {
    if (!KNOWN_FLAGS.has(a)) {
      err.write(`canary uninstall: unknown option "${a}".\n`);
      return 1;
    }
  }

  const scopes: Scope[] = [];
  if (argv.includes('--global')) scopes.push('global');
  if (argv.includes('--project')) scopes.push('project');
  if (argv.includes('--all')) scopes.push('all');

  if (scopes.length === 0) {
    err.write(`canary uninstall: choose a scope.\n${SCOPE_HELP}`);
    return 1;
  }
  if (scopes.length > 1) {
    err.write(
      'canary uninstall: pass exactly one of --global/--project/--all.\n',
    );
    return 1;
  }

  const scope = scopes[0];
  const apply = argv.includes('--apply');
  const includeGenerated = argv.includes('--include-generated');

  const artifacts = enumerate({ scope, includeGenerated }, deps);
  let failed: RemovalOutcome['failed'] = [];
  if (apply) {
    failed = removeAll(artifacts, deps).failed;
  }

  // Hand the failures to the renderer so a removal that threw is never counted
  // as removed — the report must not be cleaner than the outcome.
  out.write(
    `${render(artifacts, { scope, apply, failed: failed.map((f) => f.artifact) })}\n`,
  );
  for (const f of failed) {
    err.write(
      `canary uninstall: failed to remove ${f.artifact.path}: ${f.error}\n`,
    );
  }
  return failed.length > 0 ? 1 : 0;
}
