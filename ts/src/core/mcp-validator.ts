/**
 * MCP server identifier validation for company knowledge.
 *
 * Faithful TypeScript port of `agent/core/mcp_validator.py`. Resolves which MCP
 * server identifiers are registered in the current Claude Code session by
 * scanning:
 *
 *   1. `<root>/.mcp.json` and `~/.mcp.json`  — plain server keys (e.g. "harness")
 *   2. Installed Claude Code plugins          — plugin-prefixed keys
 *      Format: `plugin_{plugin_slug}_{server_key}`
 *      e.g. atlassian plugin, "atlassian" server → "plugin_atlassian_atlassian"
 *
 * No network calls are made; this is a local config scan only.
 *
 * Python→TS nuances:
 *   - **Home injection**: Python's tests `patch("...Path.home")`. The idiomatic
 *     TS seam is an optional `home` parameter (defaulting to `os.homedir()`),
 *     threaded down exactly where Python calls `Path.home()`. Production
 *     behavior is unchanged when omitted; this mirrors the sibling
 *     `overlays.ts`, which already takes a `home` parameter.
 *   - A non-object top-level `.mcp.json`/`settings.json` (e.g. a JSON array)
 *     would make Python's `data.get(...)` raise an *uncaught* `AttributeError`;
 *     we degrade to "no servers" instead (safer, and never observable via a
 *     well-formed config).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readJsonWithWarning } from './config-validation.js';

/** `[source_label, note, status]` — one registry entry (Python 3-tuple). */
type RegistryEntry = [string, string, string];

/** Result of validating one MCP server id (Python `MCPValidationResult`). */
export class MCPValidationResult {
  server_id: string;
  status: string; // "registered" | "not_found" | "plugin_disabled"
  source: string; // where it was found (for display)
  note: string;

  constructor(serverId: string, status: string, source = '', note = '') {
    this.server_id = serverId;
    this.status = status;
    this.source = source;
    this.note = note;
  }
}

/**
 * Check each `serverId` against locally registered MCP sources.
 *
 * Returns one {@link MCPValidationResult} per id, in input order.
 */
export function validateMcpServers(
  serverIds: string[],
  root?: string | null,
  home?: string | null,
): MCPValidationResult[] {
  const registry = buildRegistry(root ?? process.cwd(), home ?? homedir());
  const results: MCPValidationResult[] = [];
  for (const sid of serverIds) {
    const entry = registry.get(sid);
    if (entry !== undefined) {
      const [source, note, status] = entry;
      results.push(new MCPValidationResult(sid, status, source, note));
    } else {
      results.push(new MCPValidationResult(sid, 'not_found'));
    }
  }
  return results;
}

/**
 * Fail-loud (but non-blocking) config-validation pass for `.mcp.json`.
 *
 * `validateMcpServers` silently treats a malformed `.mcp.json` the same as an
 * absent one (each server resolves to "not_found"). This is a separate, explicit
 * pass a caller can run alongside it to surface the distinction: an
 * existing-but-unparseable `.mcp.json` (project or home) returns a warning
 * naming the file and the parse error. A genuinely absent `.mcp.json` is not a
 * warning. Never raises.
 */
export function collectConfigWarnings(
  root?: string | null,
  home?: string | null,
): string[] {
  const r = root ?? process.cwd();
  const h = home ?? homedir();
  const warnings: string[] = [];
  for (const path of [join(r, '.mcp.json'), join(h, '.mcp.json')]) {
    const [, warning] = readJsonWithWarning(path);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

// ── registry builder ──────────────────────────────────────────────────────

/**
 * Return a `Map` of `server_id -> [source_label, note, status]` for all locally
 * known MCP servers (Python `_build_registry`).
 */
export function buildRegistry(
  root: string,
  home: string = homedir(),
): Map<string, RegistryEntry> {
  const registry = new Map<string, RegistryEntry>();

  // 1. Project-local .mcp.json
  ingestMcpJson(join(root, '.mcp.json'), 'project .mcp.json', registry);

  // 2. Home-dir .mcp.json
  ingestMcpJson(join(home, '.mcp.json'), '~/.mcp.json', registry);

  // 3. Installed Claude Code plugins
  ingestPlugins(registry, home);

  return registry;
}

function ingestMcpJson(
  path: string,
  label: string,
  registry: Map<string, RegistryEntry>,
): void {
  if (!existsSync(path)) return;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return;
  }
  // INTENTIONAL DIVERGENCE from the oracle: on a valid-JSON-but-non-object top
  // level (e.g. a bare array `[]`), Python calls `data.get("mcpServers", {})`
  // on a list → uncaught AttributeError, crashing the caller. We degrade to
  // "no servers" instead — safer, never reachable via a well-formed config, and
  // consistent with the accepted-divergence notes in config-validation.ts /
  // coverage.ts. Pinned by a regression test.
  const servers = isRecord(data) ? data['mcpServers'] : undefined;
  if (!isRecord(servers)) return;
  for (const key of Object.keys(servers)) {
    if (!registry.has(key)) registry.set(key, [label, '', 'registered']);
  }
}

/**
 * Scan installed Claude Code plugins and derive their MCP server identifiers.
 */
function ingestPlugins(
  registry: Map<string, RegistryEntry>,
  home: string,
): void {
  const pluginsCache = join(home, '.claude', 'plugins', 'cache');
  if (!isDir(pluginsCache)) return;

  const enabled = loadEnabledPlugins(home);

  for (const marketplaceSlug of listDirs(pluginsCache)) {
    const marketplacePath = join(pluginsCache, marketplaceSlug);
    for (const pluginSlug of listDirs(marketplacePath)) {
      const pluginPath = join(marketplacePath, pluginSlug);
      const pluginKey = `${pluginSlug}@${marketplaceSlug}`;
      const isEnabled = enabled[pluginKey] ?? false;

      // Each plugin may have multiple version dirs; use the most recent.
      const versionDirs = listDirs(pluginPath)
        .map((name) => ({
          name,
          mtime: statSync(join(pluginPath, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      for (const vd of versionDirs) {
        const mcpJson = join(pluginPath, vd.name, '.mcp.json');
        if (!existsSync(mcpJson)) continue;
        let data: unknown;
        try {
          data = JSON.parse(readFileSync(mcpJson, 'utf-8'));
        } catch {
          continue;
        }

        const servers = isRecord(data) ? data['mcpServers'] : undefined;
        if (isRecord(servers)) {
          for (const serverKey of Object.keys(servers)) {
            // Claude Code tool namespace: plugin_{plugin_slug}_{server_key}
            const derivedId = `plugin_${pluginSlug}_${serverKey}`;
            if (registry.has(derivedId)) continue;
            const status = isEnabled ? 'registered' : 'plugin_disabled';
            const note = isEnabled
              ? ''
              : `plugin ${pyRepr(pluginKey)} is installed but not enabled`;
            const source = `plugin ${pyRepr(pluginKey)}`;
            registry.set(derivedId, [source, note, status]);
          }
        }
        break; // only inspect the most recent version dir that has .mcp.json
      }
    }
  }
}

/** Load `enabledPlugins` from `~/.claude/settings.json`. */
function loadEnabledPlugins(home: string): Record<string, boolean> {
  const settingsPath = join(home, '.claude', 'settings.json');
  try {
    const data: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (isRecord(data)) {
      const enabled = data['enabledPlugins'];
      if (isRecord(enabled)) return enabled as Record<string, boolean>;
    }
  } catch {
    // OSError / JSON parse error → empty map.
  }
  return {};
}

// ── small helpers ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Sorted directory names under `path` that are themselves directories. */
function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Python `repr()` of a simple string: single-quote wrapped. */
function pyRepr(s: string): string {
  return `'${s}'`;
}
