/**
 * Shared vocabulary for `canary uninstall`: the artifact model every phase
 * speaks, plus the filesystem helpers the scan needs. Split out so the scan,
 * render, and removal modules each stay independently readable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MARKETPLACE = 'bop-clocktower';
export const PLUGIN_KEY = 'canary@bop-clocktower';
export const MCP_KEY = 'canary-mcp';

export type Scope = 'global' | 'project' | 'all';

/**
 * `removable` — the CLI will delete it under `--apply`.
 * `blocked`   — found, deliberately not removed; `reason` says why.
 * `manual`    — someone else owns it; `reason` carries the exact command.
 */
export type Disposition = 'removable' | 'blocked' | 'manual';

export interface Artifact {
  scope: 'global' | 'project';
  kind: string;
  label: string;
  path: string | null;
  disposition: Disposition;
  reason?: string;
  sizeBytes?: number;
}

export interface EnumerateOptions {
  scope: Scope;
  includeGenerated?: boolean;
}

export type GitRunner = (
  args: string[],
  opts?: { cwd?: string },
) => { status: number | null; stdout: string; stderr: string };

export interface Writer {
  write: (s: string) => void;
}

export interface UninstallDeps {
  homeDir?: string;
  cwd?: string;
  out?: Writer;
  err?: Writer;
  git?: GitRunner;
  /** Resolved path of the running CLI, injectable for tests. */
  cliPath?: string;
}

export const defaultGit: GitRunner = (args, opts = {}) => {
  const r = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Recursive byte size; best-effort, never throws. */
export function dirSize(target: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let kids: string[] = [];
      try {
        kids = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const k of kids) walk(path.join(p, k));
    } else {
      total += st.size;
    }
  };
  walk(target);
  return total;
}
