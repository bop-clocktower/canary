/**
 * Enumeration half of `canary uninstall` — walks the install footprint and
 * classifies every artifact it finds. Pure discovery: nothing here writes or
 * deletes, so the dry-run and `--apply` paths read from one source of truth.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as registry from './overlays-registry.js';
import {
  MARKETPLACE,
  MCP_KEY,
  PLUGIN_KEY,
  defaultGit,
  dirSize,
  readJson,
  type Artifact,
  type EnumerateOptions,
  type UninstallDeps,
} from './uninstall-types.js';

/**
 * Every install path Claude Code currently considers live.
 *
 * Read from `installPath`, NEVER inferred by sorting version numbers: a real
 * machine had 4.0.0, 6.3.0, 6.4.0, 6.5.0, 6.6.0 and 6.7.1 cached with **6.4.0**
 * registered, so a highest-version heuristic would delete the live install and
 * leave five orphans. Every entry counts (a plugin may be registered at more
 * than one scope), so all of them are protected.
 */
function registeredInstallPaths(pluginsDir: string): Set<string> {
  const manifest = readJson(
    path.join(pluginsDir, 'installed_plugins.json'),
  ) as {
    plugins?: Record<string, unknown>;
  } | null;
  const entries = manifest?.plugins?.[PLUGIN_KEY];
  const out = new Set<string>();
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    const p = (e as { installPath?: unknown } | null)?.installPath;
    if (typeof p === 'string' && p.length > 0) out.add(path.resolve(p));
  }
  return out;
}

function enumerateGlobal(
  opts: EnumerateOptions,
  deps: UninstallDeps,
): Artifact[] {
  const home = deps.homeDir ?? os.homedir();
  const git = deps.git ?? defaultGit;
  const found: Artifact[] = [];

  const pluginsDir = path.join(home, '.claude', 'plugins');
  const cacheRoot = path.join(pluginsDir, 'cache', MARKETPLACE, 'canary');
  const registered = registeredInstallPaths(pluginsDir);

  let versions: string[] = [];
  try {
    versions = fs
      .readdirSync(cacheRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    versions = [];
  }

  for (const v of versions.sort()) {
    const dir = path.join(cacheRoot, v);
    const isLive = registered.has(path.resolve(dir));
    found.push({
      scope: 'global',
      kind: 'plugin-cache',
      label: `plugin cache ${v}`,
      path: dir,
      disposition: isLive ? 'blocked' : 'removable',
      reason: isLive
        ? 'currently registered — run `/plugin uninstall` first, then re-run'
        : undefined,
      sizeBytes: dirSize(dir),
    });
  }

  if (registered.size > 0) {
    found.push({
      scope: 'global',
      kind: 'plugin-registration',
      label: 'Claude Code plugin registration',
      path: path.join(pluginsDir, 'installed_plugins.json'),
      disposition: 'manual',
      reason: `/plugin uninstall ${PLUGIN_KEY}`,
    });
  }

  const marketplace = path.join(pluginsDir, 'marketplaces', MARKETPLACE);
  if (fs.existsSync(marketplace)) {
    found.push({
      scope: 'global',
      kind: 'marketplace',
      label: 'marketplace clone',
      path: marketplace,
      disposition: 'manual',
      reason: `/plugin marketplace remove ${MARKETPLACE}`,
      sizeBytes: dirSize(marketplace),
    });
  }

  // Overlays: skip dirty, remove clean. `overlay update` already refuses on a
  // dirty tree; a bulk sweep has even less business destroying local edits.
  let overlays: registry.OverlayEntry[] = [];
  try {
    overlays = registry.list(registry.read(home));
  } catch {
    overlays = [];
  }
  for (const entry of overlays) {
    const exists = fs.existsSync(entry.path);
    const status = exists
      ? git(['status', '--porcelain'], { cwd: entry.path })
      : null;
    const dirty = status
      ? status.status !== 0 || status.stdout.trim() !== ''
      : false;
    found.push({
      scope: 'global',
      kind: 'overlay',
      label: `overlay ${entry.name}`,
      path: entry.path,
      disposition: dirty ? 'blocked' : 'removable',
      reason: dirty
        ? 'has local edits — commit or discard them first'
        : undefined,
      sizeBytes: exists ? dirSize(entry.path) : 0,
    });
  }

  found.push({
    scope: 'global',
    kind: 'cli-binary',
    label: 'CLI binary',
    path: deps.cliPath ?? process.argv[1] ?? null,
    disposition: 'manual',
    reason: cliRemovalHint(deps.cliPath ?? process.argv[1] ?? ''),
  });

  return found;
}

/**
 * The removal command for however the CLI was installed. Detection is a hint,
 * not a claim — an unrecognised root falls back to naming all of them rather
 * than guessing one.
 */
function cliRemovalHint(cliPath: string): string {
  const p = cliPath.toLowerCase();
  if (p.includes('volta')) return 'volta uninstall canary-test-cli';
  if (p.includes('mise') || p.includes('.asdf'))
    return 'mise unuse -g npm:canary-test-cli';
  if (p.includes('node_modules')) return 'npm uninstall -g canary-test-cli';
  return 'npm uninstall -g canary-test-cli   (or volta/mise equivalent)';
}

function enumerateProject(
  opts: EnumerateOptions,
  deps: UninstallDeps,
): Artifact[] {
  const cwd = deps.cwd ?? process.cwd();
  const found: Artifact[] = [];
  const includeGenerated = opts.includeGenerated === true;

  const canaryDir = path.join(cwd, '.canary');
  const quarantine = path.join(canaryDir, 'quarantine.json');
  const hasQuarantine = fs.existsSync(quarantine);

  if (fs.existsSync(canaryDir)) {
    found.push({
      scope: 'project',
      kind: 'project-config',
      label: '.canary/ project config',
      path: canaryDir,
      disposition: 'removable',
      sizeBytes: dirSize(canaryDir),
    });
  }

  if (hasQuarantine) {
    found.push({
      scope: 'project',
      kind: 'quarantine-ledger',
      label: '.canary/quarantine.json (deleted-test ledger)',
      path: quarantine,
      disposition: includeGenerated ? 'removable' : 'blocked',
      reason: includeGenerated
        ? undefined
        : `records why tests were deleted — pass --include-generated to remove`,
      sizeBytes: dirSize(quarantine),
    });
  }

  const reports = path.join(cwd, 'test-results', 'reports');
  if (fs.existsSync(reports)) {
    found.push({
      scope: 'project',
      kind: 'project-reports',
      label: 'test-results/reports/',
      path: reports,
      disposition: 'removable',
      sizeBytes: dirSize(reports),
    });
  }

  const generated = path.join(cwd, 'tests', 'generated');
  if (fs.existsSync(generated)) {
    let count = 0;
    try {
      count = fs.readdirSync(generated).length;
    } catch {
      count = 0;
    }
    found.push({
      scope: 'project',
      kind: 'generated-tests',
      label: `tests/generated/ (${count} file(s))`,
      path: generated,
      disposition: includeGenerated ? 'removable' : 'blocked',
      reason: includeGenerated
        ? undefined
        : 'unpromoted generated tests — pass --include-generated to remove',
      sizeBytes: dirSize(generated),
    });
  }

  // `.mcp.json` is shared with other servers, so only our key comes out.
  const mcpPath = path.join(cwd, '.mcp.json');
  const mcp = readJson(mcpPath) as {
    mcpServers?: Record<string, unknown>;
  } | null;
  if (mcp?.mcpServers && Object.hasOwn(mcp.mcpServers, MCP_KEY)) {
    found.push({
      scope: 'project',
      kind: 'mcp-entry',
      label: `.mcp.json → "${MCP_KEY}" server entry`,
      path: mcpPath,
      disposition: 'removable',
    });
  }

  return found;
}

export function enumerate(
  opts: EnumerateOptions,
  deps: UninstallDeps = {},
): Artifact[] {
  const out: Artifact[] = [];
  if (opts.scope === 'global' || opts.scope === 'all') {
    out.push(...enumerateGlobal(opts, deps));
  }
  if (opts.scope === 'project' || opts.scope === 'all') {
    out.push(...enumerateProject(opts, deps));
  }
  return out;
}

export interface RemovalOutcome {
  removed: Artifact[];
  failed: Array<{ artifact: Artifact; error: string }>;
}

/**
 * Remove `.canary/` while preserving the quarantine ledger when it was not
 * opted into. Deleting the directory wholesale would take the ledger with it,
 * silently undoing the protection the `blocked` disposition just promised.
 */
