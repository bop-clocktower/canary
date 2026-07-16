"use strict";

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSource, SourceSpecError } from "./source-spec.js";
import * as registry from "./overlays-registry.js";

/** Result of running a git subcommand. */
export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a git subcommand and captures status/stdout/stderr (never throws). */
export type GitRunner = (args: string[], opts?: { cwd?: string }) => GitResult;

/** Sink for command output — matches the write() slice of a WritableStream. */
export interface Writer {
  write(chunk: string): void;
}

export interface CommandDeps {
  git?: GitRunner;
  homeDir?: string;
  out?: Writer;
  err?: Writer;
  /** ISO date stamp for new registry entries (injectable for tests). */
  now?: () => string;
}

const defaultGit: GitRunner = (args, opts = {}) => {
  const r = spawnSync("git", args, { cwd: opts.cwd, encoding: "utf8" });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return { status: code === "ENOENT" ? 127 : 1, stdout: "", stderr: String(r.error.message) };
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Best-effort classification of a failed `git clone`, for a useful remedy. */
export function classifyCloneFailure(res: GitResult): string {
  const s = res.stderr.toLowerCase();
  if (res.status === 127 || s.includes("enoent") || s.includes("not found: git")) {
    return "git not found on PATH";
  }
  if (
    s.includes("could not resolve host") ||
    s.includes("network is unreachable") ||
    s.includes("failed to connect") ||
    s.includes("timed out")
  ) {
    return "network unreachable";
  }
  if (
    s.includes("authentication failed") ||
    s.includes("permission denied") ||
    s.includes("could not read username") ||
    s.includes("access denied") ||
    s.includes("403 forbidden")
  ) {
    return "authentication denied";
  }
  if (s.includes("repository not found") || s.includes("does not exist") || s.includes("not found")) {
    return "repository not found";
  }
  return "unknown error";
}

/**
 * `canary overlay add <source> [--ref <tag>]` — clone a tracked overlay into
 * `~/.canary/overlays/<name>/` and register it. Returns a process exit code.
 * Nothing is registered unless the clone succeeds.
 */
export function add(
  source: string,
  options: { ref?: string | null } = {},
  deps: CommandDeps = {}
): number {
  const git = deps.git ?? defaultGit;
  const homeDir = deps.homeDir ?? os.homedir();
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  const stamp = deps.now ?? today;
  const ref = options.ref ?? null;

  let parsed;
  try {
    parsed = parseSource(source);
  } catch (e) {
    if (e instanceof SourceSpecError) {
      err.write(`canary overlay add: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  let reg;
  try {
    reg = registry.read(homeDir);
  } catch (e) {
    err.write(`canary overlay add: ${(e as Error).message}\n`);
    return 1;
  }

  // Idempotent: re-adding a registered overlay is a no-op with an update hint.
  if (registry.get(reg, parsed.name)) {
    out.write(
      `overlay "${parsed.name}" is already added — run 'canary overlay update ${parsed.name}' to refresh it.\n`
    );
    return 0;
  }

  const dest = registry.clonePath(parsed.name, homeDir);
  if (fs.existsSync(dest)) {
    err.write(
      `canary overlay add: ${dest} already exists but is not registered — remove it and retry.\n`
    );
    return 1;
  }

  fs.mkdirSync(registry.overlaysDir(homeDir), { recursive: true });
  const args = ["clone", "--quiet"];
  if (ref) {
    args.push("--branch", ref);
  }
  args.push(parsed.cloneUrl, dest);

  const res = git(args);
  if (res.status !== 0) {
    fs.rmSync(dest, { recursive: true, force: true }); // never leave a partial clone
    const reason = classifyCloneFailure(res);
    err.write(
      `canary overlay add: clone failed (${reason}).\n` +
        (res.stderr.trim() ? `${res.stderr.trim()}\n` : "") +
        `Nothing was registered. Check the overlay's access docs and your git credentials.\n`
    );
    return 1;
  }

  const entry: registry.OverlayEntry = {
    name: parsed.name,
    source,
    ref,
    path: dest,
    addedDate: stamp(),
    consent: null,
  };
  try {
    registry.write(registry.add(reg, entry), homeDir);
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    err.write(`canary overlay add: ${(e as Error).message}\n`);
    return 1;
  }

  out.write(`Added overlay "${parsed.name}"${ref ? ` @ ${ref}` : ""} → ${dest}\n`);
  return 0;
}

/** Count `.canary/skills/<name>/SKILL.md` entries in a clone. */
export function skillCount(dest: string): number {
  const skillsDir = path.join(dest, ".canary", "skills");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter(
    (d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, "SKILL.md"))
  ).length;
}

/**
 * Freshness of a clone against its LOCAL knowledge of the upstream — no fetch
 * is performed (that is `overlay update`'s job). Returns a human-readable
 * status string.
 */
export function freshness(dest: string, entry: registry.OverlayEntry, git: GitRunner): string {
  if (!fs.existsSync(dest)) {
    return "missing — clone not found (run 'canary overlay update' or re-add)";
  }
  const behind = git(["rev-list", "--count", "HEAD..@{u}"], { cwd: dest });
  if (behind.status !== 0) {
    // No upstream tracking ref — typically a pinned tag/detached HEAD.
    return entry.ref ? `pinned @ ${entry.ref}` : "unknown (no upstream tracking ref)";
  }
  const n = Number.parseInt(behind.stdout.trim(), 10);
  if (!Number.isFinite(n) || n === 0) {
    return "up to date";
  }
  return `${n} commit${n === 1 ? "" : "s"} behind`;
}

/**
 * `canary overlay list` — one block per registered overlay: name, source, ref,
 * freshness, and skill count.
 */
export function list(deps: CommandDeps = {}): number {
  const git = deps.git ?? defaultGit;
  const homeDir = deps.homeDir ?? os.homedir();
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;

  let reg;
  try {
    reg = registry.read(homeDir);
  } catch (e) {
    err.write(`canary overlay list: ${(e as Error).message}\n`);
    return 1;
  }

  if (reg.overlays.length === 0) {
    out.write("No overlays added. Add one with 'canary overlay add <source>'.\n");
    return 0;
  }

  for (const o of reg.overlays) {
    out.write(`${o.name}\n`);
    out.write(`  source:  ${o.source}\n`);
    out.write(`  ref:     ${o.ref ?? "(default branch)"}\n`);
    out.write(`  status:  ${freshness(o.path, o, git)}\n`);
    out.write(`  skills:  ${skillCount(o.path)}\n`);
  }
  return 0;
}
