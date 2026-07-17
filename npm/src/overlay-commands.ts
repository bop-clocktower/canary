"use strict";

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSource, SourceSpecError } from "./source-spec.js";
import * as registry from "./overlays-registry.js";
import { commandSucceedsHash, loadManifest } from "./doctor-manifest.js";

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
  /** Interactive yes/no prompt for the `overlay add` consent gate (injectable). */
  confirm?: (question: string) => boolean;
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

/** Default consent prompt: reads a line from the TTY; declines when non-interactive. */
function defaultConfirm(question: string): boolean {
  if (!process.stdin.isTTY) {
    return false;
  }
  process.stdout.write(question);
  const buf = Buffer.alloc(256);
  try {
    const n = fs.readSync(0, buf, 0, buf.length, null);
    const answer = buf.toString("utf8", 0, n).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  }
}

/**
 * Consent for an overlay's `command-succeeds` doctor checks, collected at add
 * time. Overlays with no such checks (or a malformed manifest) record no
 * consent (`null`) — there is nothing to gate, and a bad manifest surfaces
 * later in `doctor`. Otherwise the check list is printed and confirmed.
 */
function collectConsent(
  dest: string,
  name: string,
  confirm: (question: string) => boolean,
  out: Writer
): { consent: boolean | null; consentCommandsHash: string | null } {
  const load = loadManifest(dest);
  if (!load.ok) {
    return { consent: null, consentCommandsHash: null };
  }
  const hash = commandSucceedsHash(load.checks);
  if (hash === null) {
    return { consent: null, consentCommandsHash: null };
  }
  const cmds = load.checks.filter((c) => c.type === "command-succeeds");
  out.write(`Overlay "${name}" ships ${cmds.length} command check(s) that 'canary doctor' can run:\n`);
  for (const c of cmds) {
    out.write(`  - ${c.id}: ${(c.command ?? []).join(" ")}\n`);
  }
  const granted = confirm(`Allow 'canary doctor' to run these commands for "${name}"? [y/N] `);
  if (!granted) {
    out.write("Declined — 'canary doctor' will skip these command checks. Re-add the overlay to change this.\n");
  }
  return { consent: granted, consentCommandsHash: hash };
}

/** Ordered stderr-substring signatures for `git clone` failure classification. */
const CLONE_FAILURE_SIGNATURES: ReadonlyArray<{ reason: string; needles: readonly string[] }> = [
  { reason: "git not found on PATH", needles: ["enoent", "not found: git"] },
  {
    reason: "network unreachable",
    needles: ["could not resolve host", "network is unreachable", "failed to connect", "timed out"],
  },
  {
    reason: "authentication denied",
    needles: ["authentication failed", "permission denied", "could not read username", "access denied", "403 forbidden"],
  },
  { reason: "repository not found", needles: ["repository not found", "does not exist", "not found"] },
];

/** Best-effort classification of a failed `git clone`, for a useful remedy. */
export function classifyCloneFailure(res: GitResult): string {
  const s = res.stderr.toLowerCase();
  if (res.status === 127) {
    return "git not found on PATH";
  }
  for (const { reason, needles } of CLONE_FAILURE_SIGNATURES) {
    if (needles.some((needle) => s.includes(needle))) {
      return reason;
    }
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

  const confirm = deps.confirm ?? defaultConfirm;
  const { consent, consentCommandsHash } = collectConsent(dest, parsed.name, confirm, out);
  const entry: registry.OverlayEntry = {
    name: parsed.name,
    source,
    ref,
    path: dest,
    addedDate: stamp(),
    consent,
    consentCommandsHash,
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

/** Working-tree cleanliness of a clone. */
export type CleanStatus = "clean" | "dirty" | "unreadable";

/**
 * Whether a clone's working tree is clean, dirty (local modifications), or its
 * git status is unreadable. Shared by `overlay update` (refuses on dirty) and
 * the `doctor` engine check ("no local overlay modifications").
 */
export function workingTreeStatus(dest: string, git: GitRunner): CleanStatus {
  const status = git(["status", "--porcelain"], { cwd: dest });
  if (status.status !== 0) {
    return "unreadable";
  }
  return status.stdout.trim() === "" ? "clean" : "dirty";
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

/** Update one overlay clone. Returns 0 on success, 1 on refusal/failure. */
function updateOne(o: registry.OverlayEntry, git: GitRunner, out: Writer, err: Writer): number {
  if (!fs.existsSync(o.path)) {
    err.write(`overlay "${o.name}": clone missing at ${o.path} — remove and re-add it.\n`);
    return 1;
  }

  const clean = workingTreeStatus(o.path, git);
  if (clean === "unreadable") {
    err.write(`overlay "${o.name}": cannot read git status at ${o.path}.\n`);
    return 1;
  }
  if (clean === "dirty") {
    err.write(
      `overlay "${o.name}": local modifications in ${o.path} — refusing to update. ` +
        `Commit/stash them, or 'canary overlay remove ${o.name}' and re-add.\n`
    );
    return 1;
  }

  if (o.ref) {
    // Pinned to a tag/branch: fetch (incl. tags), then re-checkout the ref.
    const fetch = git(["fetch", "--quiet", "--tags", "origin"], { cwd: o.path });
    if (fetch.status !== 0) {
      err.write(`overlay "${o.name}": fetch failed.\n${fetch.stderr.trim()}\n`);
      return 1;
    }
    const co = git(["checkout", "--quiet", o.ref], { cwd: o.path });
    if (co.status !== 0) {
      err.write(`overlay "${o.name}": checkout ${o.ref} failed.\n${co.stderr.trim()}\n`);
      return 1;
    }
    out.write(`overlay "${o.name}": fetched, pinned @ ${o.ref}.\n`);
    return 0;
  }

  const pull = git(["pull", "--ff-only", "--quiet"], { cwd: o.path });
  if (pull.status !== 0) {
    err.write(
      `overlay "${o.name}": cannot fast-forward ${o.path} ` +
        `(diverged or rewritten history) — 'canary overlay remove ${o.name}' and re-add.\n` +
        (pull.stderr.trim() ? `${pull.stderr.trim()}\n` : "")
    );
    return 1;
  }
  out.write(`overlay "${o.name}": updated.\n`);
  return 0;
}

/**
 * `canary overlay update [name]` — fast-forward tracked overlays. With no name,
 * updates all; refuses on local modifications or a non-fast-forward.
 */
export function update(name: string | null, deps: CommandDeps = {}): number {
  const git = deps.git ?? defaultGit;
  const homeDir = deps.homeDir ?? os.homedir();
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;

  let reg;
  try {
    reg = registry.read(homeDir);
  } catch (e) {
    err.write(`canary overlay update: ${(e as Error).message}\n`);
    return 1;
  }

  let targets: registry.OverlayEntry[];
  if (name) {
    const entry = registry.get(reg, name);
    if (!entry) {
      err.write(`canary overlay update: no overlay named "${name}".\n`);
      return 1;
    }
    targets = [entry];
  } else {
    if (reg.overlays.length === 0) {
      out.write("No overlays to update.\n");
      return 0;
    }
    targets = reg.overlays;
  }

  let failures = 0;
  for (const o of targets) {
    if (updateOne(o, git, out, err) !== 0) {
      failures += 1;
    }
  }
  return failures === 0 ? 0 : 1;
}

/**
 * `canary overlay remove <name>` — deregister an overlay and delete its clone.
 * Unknown name is an error; the registry is left unchanged in that case.
 */
export function remove(name: string, deps: CommandDeps = {}): number {
  const homeDir = deps.homeDir ?? os.homedir();
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;

  let reg;
  try {
    reg = registry.read(homeDir);
  } catch (e) {
    err.write(`canary overlay remove: ${(e as Error).message}\n`);
    return 1;
  }

  const entry = registry.get(reg, name);
  if (!entry) {
    err.write(`canary overlay remove: no overlay named "${name}".\n`);
    return 1;
  }

  fs.rmSync(entry.path, { recursive: true, force: true });
  const { registry: next } = registry.remove(reg, name);
  registry.write(next, homeDir);
  out.write(`Removed overlay "${name}".\n`);
  return 0;
}
