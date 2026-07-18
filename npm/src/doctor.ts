"use strict";

/**
 * `canary doctor` — environment self-check (Phase 2).
 *
 * Runs two tiers of checks and prints each as pass/fail with a remedy line
 * under every failure, adopting the `harness doctor` output shape; the process
 * exits non-zero when any check fails. Tier 1 is built-in engine checks; tier 2
 * is data-driven checks read from each tracked overlay's `.canary/doctor.json`.
 */

import * as os from "node:os";
import type { CommandDeps } from "./overlay-commands.js";
import { runEngineChecks, type EngineCheckDeps } from "./engine-checks.js";
import {
  collectPersonas,
  commandSucceedsHash,
  filterByPersona,
  loadManifest,
  runCheck,
  type CommandRunner,
  type ManifestCheck,
  type UrlProbe,
} from "./doctor-manifest.js";
import * as registry from "./overlays-registry.js";

/** Outcome of a single doctor check. */
export type CheckStatus = "pass" | "fail" | "skip" | "info";

/** A single doctor check result, rendered as one output line. */
export interface CheckResult {
  /** Stable identifier (engine check id, or the manifest check's `id`). */
  id: string;
  status: CheckStatus;
  /** Human-readable label for the check line. */
  label: string;
  /** Shown indented under the line when the check does not pass. */
  remedy?: string;
}

/** Dependencies for `doctor`, injectable for tests (real ones by default). */
export interface DoctorDeps extends CommandDeps {
  /** Current working directory (for project `.canary/` and `.mcp.json`). */
  cwd?: string;
  currentVersion?: string;
  getLatestVersion?: () => Promise<string | null>;
  probeUrl?: UrlProbe;
  runCommand?: CommandRunner;
  timeoutMs?: number;
}

/** One printed section: a header and its check results. */
interface CheckGroup {
  header: string;
  results: CheckResult[];
}

const SYMBOL: Record<CheckStatus, string> = { pass: "✓", fail: "✗", skip: "-", info: "ℹ" };

/** `--persona <tag>` / `--persona=<tag>`, or null when unset. */
function parsePersona(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--persona") {
      return args[i + 1] ?? null;
    }
    if (a.startsWith("--persona=")) {
      return a.slice("--persona=".length);
    }
  }
  return null;
}

/**
 * Fail-loud hint for an unrecognized `--persona` value (issue #294). Returns
 * null when there is nothing to say — no persona was passed, or the passed
 * persona is part of the known vocabulary. Otherwise returns a one-line,
 * actionable message: the engine ships no persona vocabulary, so this lists
 * the tags overlays actually declared (or says none are defined) instead of
 * silently running only the persona-less checks and leaving the user to
 * guess why their filter matched nothing.
 */
export function unknownPersonaHint(persona: string | null, known: readonly string[]): string | null {
  if (persona === null) {
    return null;
  }
  const want = persona.toLowerCase();
  if (known.some((p) => p.toLowerCase() === want)) {
    return null;
  }
  if (known.length === 0) {
    return `--persona '${persona}' matched no checks: no overlay defines any personas, so every check already runs. Drop the flag.`;
  }
  return `--persona '${persona}' is not a known persona. Valid options: ${known.join(", ")}. (Omit --persona to run every check.)`;
}

function renderCheck(r: CheckResult): string {
  const line = `  ${SYMBOL[r.status]} ${r.label}\n`;
  return r.status === "fail" && r.remedy ? `${line}      → ${r.remedy}\n` : line;
}

/** Load, persona-filter, and run one overlay's manifest checks. */
async function overlayResults(
  entry: registry.OverlayEntry,
  deps: DoctorDeps,
  persona: string | null
): Promise<{ group: CheckGroup; loadedChecks: ManifestCheck[] }> {
  const header = `Overlay: ${entry.name}`;
  const load = loadManifest(entry.path);
  if (!load.ok) {
    return { group: { header, results: [load.failure] }, loadedChecks: [] };
  }
  const granted = registry.consentGranted(entry, commandSucceedsHash(load.checks));
  const checks = filterByPersona(load.checks, persona);
  const ctx = {
    cloneDir: entry.path,
    consentGranted: granted,
    timeoutMs: deps.timeoutMs,
    probeUrl: deps.probeUrl,
    runCommand: deps.runCommand,
  };
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runCheck(check, ctx));
  }
  // Return the full (pre-filter) check set so the caller can build the
  // persona vocabulary for a fail-loud hint on an unknown --persona.
  return { group: { header, results }, loadedChecks: load.checks };
}

/**
 * Run `canary doctor`. Returns a process exit code: 0 when every check passed
 * or was skipped/info, non-zero when any check failed. A malformed manifest for
 * one overlay never blocks engine checks or other overlays.
 */
export async function runDoctor(args: readonly string[], deps: DoctorDeps = {}): Promise<number> {
  const out = deps.out ?? process.stdout;
  const persona = parsePersona(args);
  const homeDir = deps.homeDir ?? os.homedir();

  const engineDeps: EngineCheckDeps = {
    git: deps.git,
    homeDir,
    cwd: deps.cwd,
    currentVersion: deps.currentVersion,
    getLatestVersion: deps.getLatestVersion,
    timeoutMs: deps.timeoutMs,
  };

  const groups: CheckGroup[] = [{ header: "Engine", results: await runEngineChecks(engineDeps) }];

  let reg: registry.OverlayRegistry;
  try {
    reg = registry.read(homeDir);
  } catch {
    reg = registry.emptyRegistry();
  }
  const allChecks: ManifestCheck[] = [];
  for (const entry of reg.overlays) {
    const { group, loadedChecks } = await overlayResults(entry, deps, persona);
    groups.push(group);
    allChecks.push(...loadedChecks);
  }

  out.write("canary doctor\n");

  // Issue #294: if the user passed a --persona that no overlay declares,
  // tell them the valid vocabulary instead of silently filtering to only
  // the persona-less checks and leaving them to wonder why.
  const personaHint = unknownPersonaHint(persona, collectPersonas(allChecks));
  if (personaHint) {
    out.write(`\n! ${personaHint}\n`);
  }
  let failures = 0;
  for (const group of groups) {
    out.write(`\n${group.header}\n`);
    for (const result of group.results) {
      if (result.status === "fail") {
        failures += 1;
      }
      out.write(renderCheck(result));
    }
  }
  out.write(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
  return failures === 0 ? 0 : 1;
}
