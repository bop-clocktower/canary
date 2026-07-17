"use strict";

/**
 * Overlay check manifest — `<clone>/.canary/doctor.json` (Phase 2, tier 2).
 *
 * This module loads and validates the manifest and filters checks by persona.
 * Execution of the individual check types lives in the runner (added in a
 * later task). A malformed manifest never throws: {@link loadManifest} returns
 * a single failing {@link CheckResult} so `doctor` can report it and carry on.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { CheckResult } from "./doctor.js";

export const CHECK_TYPES = ["file-exists", "url-reachable", "command-succeeds"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

/** A single validated check from an overlay's `doctor.json`. */
export interface ManifestCheck {
  id: string;
  type: CheckType;
  /** Shown under the check line when it fails. */
  remedy: string;
  /** Free-form persona tags; a check with none runs for every persona. */
  persona?: string[];
  /** `file-exists`: path relative to the overlay clone. */
  path?: string;
  /** `url-reachable`: the URL to probe. */
  url?: string;
  /** `command-succeeds`: argv array run (no shell) in the clone dir. */
  command?: string[];
}

/** Result of loading a manifest: either its checks, or a single failing check. */
export type ManifestLoad =
  | { ok: true; checks: ManifestCheck[] }
  | { ok: false; failure: CheckResult };

/** Path to an overlay's manifest. */
export function manifestPath(cloneDir: string): string {
  return path.join(cloneDir, ".canary", "doctor.json");
}

/**
 * Stable fingerprint of a manifest's `command-succeeds` checks — the (id,
 * command) pairs, sorted by id. Returns null when there are no such checks
 * (nothing to gate). Consent is re-requested when this value changes.
 */
export function commandSucceedsHash(checks: ManifestCheck[]): string | null {
  const cmds = checks
    .filter((c) => c.type === "command-succeeds")
    .map((c) => ({ id: c.id, command: c.command ?? [] }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (cmds.length === 0) {
    return null;
  }
  return createHash("sha256").update(JSON.stringify(cmds)).digest("hex");
}

/** True when `v` is a non-empty array of strings. */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((a) => typeof a === "string");
}

/**
 * Validate the type-specific field of a check. Returns an error string, or
 * null when the field is well-formed for the given type.
 */
function validateTypeField(type: CheckType, c: Record<string, unknown>): string | null {
  if (type === "file-exists" && typeof c.path !== "string") {
    return `check "${c.id}" (file-exists) is missing a string "path"`;
  }
  if (type === "url-reachable" && typeof c.url !== "string") {
    return `check "${c.id}" (url-reachable) is missing a string "url"`;
  }
  if (type === "command-succeeds" && !(isStringArray(c.command) && c.command.length > 0)) {
    return `check "${c.id}" (command-succeeds) needs a non-empty string[] "command"`;
  }
  return null;
}

/** Validate the id/type/remedy/persona fields common to every check type. */
function validateCommonFields(c: Record<string, unknown>, index: number): string | null {
  if (typeof c.id !== "string" || c.id === "") {
    return `check[${index}] is missing a string "id"`;
  }
  if (typeof c.type !== "string" || !CHECK_TYPES.includes(c.type as CheckType)) {
    return `check "${c.id}" has an unknown type (expected one of: ${CHECK_TYPES.join(", ")})`;
  }
  if (typeof c.remedy !== "string" || c.remedy === "") {
    return `check "${c.id}" is missing a string "remedy"`;
  }
  if (c.persona !== undefined && !isStringArray(c.persona)) {
    return `check "${c.id}" has a non-string persona list`;
  }
  return null;
}

/** Validate one raw check entry. Returns the typed check or an error string. */
function validateCheck(raw: unknown, index: number): ManifestCheck | string {
  if (typeof raw !== "object" || raw === null) {
    return `check[${index}] is not an object`;
  }
  const c = raw as Record<string, unknown>;
  const commonError = validateCommonFields(c, index);
  if (commonError) {
    return commonError;
  }
  const type = c.type as CheckType;
  const typeError = validateTypeField(type, c);
  if (typeError) {
    return typeError;
  }
  return {
    id: c.id as string,
    type,
    remedy: c.remedy as string,
    persona: c.persona as string[] | undefined,
    path: c.path as string | undefined,
    url: c.url as string | undefined,
    command: c.command as string[] | undefined,
  };
}

/** Build the single failing check used when a manifest cannot be loaded. */
function manifestFailure(cloneDir: string, detail: string): ManifestLoad {
  const file = manifestPath(cloneDir);
  return {
    ok: false,
    failure: {
      id: `manifest:${file}`,
      status: "fail",
      label: `doctor.json is invalid (${file})`,
      remedy: detail,
    },
  };
}

/**
 * Load and validate `<clone>/.canary/doctor.json`. A missing file is not an
 * error (no checks). A malformed file or an invalid check degrades to a single
 * failing check ({@link ManifestLoad} `ok: false`) — never a throw.
 */
export function loadManifest(cloneDir: string): ManifestLoad {
  const file = manifestPath(cloneDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, checks: [] };
    }
    return manifestFailure(cloneDir, (e as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return manifestFailure(cloneDir, `does not parse: ${(e as Error).message}`);
  }
  const checksRaw = (parsed as { checks?: unknown }).checks;
  if (!Array.isArray(checksRaw)) {
    return manifestFailure(cloneDir, 'expected an object with a "checks" array');
  }
  const checks: ManifestCheck[] = [];
  for (let i = 0; i < checksRaw.length; i += 1) {
    const result = validateCheck(checksRaw[i], i);
    if (typeof result === "string") {
      return manifestFailure(cloneDir, result);
    }
    checks.push(result);
  }
  return { ok: true, checks };
}

/**
 * Keep checks that should run for `persona`: a null persona runs everything;
 * otherwise keep checks with no persona plus those whose persona list contains
 * the tag (case-insensitive).
 */
export function filterByPersona(checks: ManifestCheck[], persona: string | null): ManifestCheck[] {
  if (persona === null) {
    return [...checks];
  }
  const want = persona.toLowerCase();
  return checks.filter(
    (c) => !c.persona || c.persona.length === 0 || c.persona.some((p) => p.toLowerCase() === want)
  );
}

/** Default per-check timeout for url and command checks. */
export const DEFAULT_CHECK_TIMEOUT_MS = 10000;

/** Probe a URL for reachability (injectable). Resolves true on a 2xx/3xx. */
export type UrlProbe = (url: string, timeoutMs: number) => Promise<boolean>;
/** Run a command (injectable). `ok` = exit 0; `timedOut` = killed at the timeout. */
export type CommandRunner = (
  command: string[],
  cwd: string,
  timeoutMs: number
) => { ok: boolean; timedOut: boolean; detail?: string };

/** Context for executing checks against one overlay clone. */
export interface RunContext {
  cloneDir: string;
  /** Whether this overlay's `command-succeeds` checks may execute. */
  consentGranted: boolean;
  timeoutMs?: number;
  probeUrl?: UrlProbe;
  runCommand?: CommandRunner;
}

function defaultProbeUrl(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let mod: typeof http | typeof https;
    try {
      mod = new URL(url).protocol === "http:" ? http : https;
    } catch {
      resolve(false);
      return;
    }
    const req = mod.get(url, (res) => {
      const s = res.statusCode ?? 0;
      res.resume();
      resolve(s >= 200 && s < 400);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

const defaultRunCommand: CommandRunner = (command, cwd, timeoutMs) => {
  const r = spawnSync(command[0], command.slice(1), { cwd, timeout: timeoutMs, encoding: "utf8" });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return { ok: false, timedOut: code === "ETIMEDOUT" || r.signal === "SIGTERM", detail: String(r.error.message) };
  }
  if (r.signal === "SIGTERM") {
    return { ok: false, timedOut: true };
  }
  return { ok: r.status === 0, timedOut: false, detail: r.status === 0 ? undefined : `exit ${r.status}` };
};

function pass(check: ManifestCheck, label: string): CheckResult {
  return { id: check.id, status: "pass", label };
}
function fail(check: ManifestCheck, label: string): CheckResult {
  return { id: check.id, status: "fail", label, remedy: check.remedy };
}

function runFileExists(check: ManifestCheck, cloneDir: string): CheckResult {
  const target = path.join(cloneDir, check.path ?? "");
  return fs.existsSync(target)
    ? pass(check, `${check.id}: ${check.path} exists`)
    : fail(check, `${check.id}: ${check.path} is missing`);
}

async function runUrlReachable(check: ManifestCheck, ctx: RunContext, timeoutMs: number): Promise<CheckResult> {
  const probe = ctx.probeUrl ?? defaultProbeUrl;
  const reachable = await probe(check.url ?? "", timeoutMs);
  return reachable
    ? pass(check, `${check.id}: ${check.url} reachable`)
    : fail(check, `${check.id}: ${check.url} unreachable`);
}

function skipped(check: ManifestCheck, reason: string): CheckResult {
  return { id: check.id, status: "skip", label: `${check.id}: skipped (${reason})` };
}

function runCommandSucceeds(check: ManifestCheck, ctx: RunContext, timeoutMs: number): CheckResult {
  if (!ctx.consentGranted) {
    return skipped(check, "command checks need consent — re-run 'canary overlay add'");
  }
  const command = check.command ?? [];
  const cmd = `\`${command.join(" ")}\``;
  const runner = ctx.runCommand ?? defaultRunCommand;
  const r = runner(command, ctx.cloneDir, timeoutMs);
  if (r.ok) {
    return pass(check, `${check.id}: ${cmd} succeeded`);
  }
  const why = r.timedOut ? `timed out after ${timeoutMs}ms` : (r.detail ?? "failed");
  return fail(check, `${check.id}: ${cmd} ${why}`);
}

/**
 * Execute one validated check against its overlay clone, under a bounded
 * timeout. `command-succeeds` is skipped (not failed) unless consent is
 * granted. Never throws.
 */
export async function runCheck(check: ManifestCheck, ctx: RunContext): Promise<CheckResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  if (check.type === "file-exists") {
    return runFileExists(check, ctx.cloneDir);
  }
  if (check.type === "url-reachable") {
    return runUrlReachable(check, ctx, timeoutMs);
  }
  return runCommandSucceeds(check, ctx, timeoutMs);
}
