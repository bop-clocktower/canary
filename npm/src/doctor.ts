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
  commandSucceedsHash,
  filterByPersona,
  loadManifest,
  runCheck,
  type CommandRunner,
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

function renderCheck(r: CheckResult): string {
  const line = `  ${SYMBOL[r.status]} ${r.label}\n`;
  return r.status === "fail" && r.remedy ? `${line}      → ${r.remedy}\n` : line;
}

/** Load, persona-filter, and run one overlay's manifest checks. */
async function overlayResults(
  entry: registry.OverlayEntry,
  deps: DoctorDeps,
  persona: string | null
): Promise<CheckGroup> {
  const header = `Overlay: ${entry.name}`;
  const load = loadManifest(entry.path);
  if (!load.ok) {
    return { header, results: [load.failure] };
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
  return { header, results };
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
  for (const entry of reg.overlays) {
    groups.push(await overlayResults(entry, deps, persona));
  }

  out.write("canary doctor\n");
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
