'use strict';

/**
 * `canary doctor` — environment self-check (Phase 2).
 *
 * Runs two tiers of checks and prints each as pass/fail with a remedy line
 * under every failure; the process exits non-zero when any check fails. Tier 1
 * is built-in engine checks; tier 2 is data-driven checks read from each
 * tracked overlay's `.canary/doctor.json`.
 *
 * Output shape (issue #318): the human text is loosely modeled on
 * `harness doctor`, but the two are NOT a shared contract and have diverged —
 * canary uses richer per-check fields (`id`/`label`/`remedy`) and a `skip`
 * status tier that harness lacks. `--json` therefore emits a *canary-owned*
 * machine contract, `{ version, checks, allPassed, warnings }`, documented in
 * `JsonReport` below. Only the top-level `allPassed` boolean intentionally
 * matches `harness doctor --json`; per-check fields are canary's own. Do not
 * build a parser that assumes the two JSON shapes are interchangeable.
 */

import * as os from 'node:os';
import type { CommandDeps } from './overlay-commands.js';
import { runEngineChecks, type EngineCheckDeps } from './engine-checks.js';
import {
  collectAudiences,
  commandSucceedsHash,
  filterByAudience,
  loadManifest,
  runCheck,
  type CommandRunner,
  type ManifestCheck,
  type UrlProbe,
} from './doctor-manifest.js';
import * as registry from './overlays-registry.js';

/** Outcome of a single doctor check. */
export type CheckStatus = 'pass' | 'fail' | 'skip' | 'info';

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

/**
 * The `canary doctor --json` machine contract (issue #318). Canary-owned and
 * intentionally distinct from `harness doctor --json`: only `allPassed` matches
 * harness's top-level shape; per-check fields (`id`/`label`/`remedy`/`group`)
 * and the `skip` status tier are canary's own. `version` guards the contract so
 * consumers can detect a breaking change.
 */
export interface JsonReportCheck {
  /** Stable check identifier (engine check id, or the manifest check's `id`). */
  id: string;
  status: CheckStatus;
  label: string;
  /** Present only when the check did not pass. */
  remedy?: string;
  /** The section the check belongs to, e.g. `"Engine"` or `"Overlay: acme"`. */
  group: string;
}

export interface JsonReport {
  version: 1;
  checks: JsonReportCheck[];
  /**
   * True iff no check failed AND at least one check was actually verified —
   * mirrors `harness doctor --json`'s one shared field. Doctrine (#508): a run
   * where every check was skipped verified nothing, so it must not report
   * `allPassed: true`.
   */
  allPassed: boolean;
  /** Denominator (#508): checks actually verified (pass + fail; skips/info excluded). */
  checked: number;
  /** Checks that did not run (consent-gated, audience-filtered, …). */
  skipped: number;
  /** True when zero checks were verified — a loud non-pass (exit 3). */
  abstained: boolean;
  /** Non-fatal advisories (e.g. an unknown `--audience`); empty when none. */
  warnings: string[];
}

/** Aggregated outcome of a doctor run — the one place summary policy lives. */
export interface DoctorSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** Denominator (#508): checks actually verified (pass + fail). */
  checked: number;
  abstained: boolean;
  /** The human summary line. Skips NEVER aggregate into "All checks passed." */
  line: string;
  /** 0 verified-and-clean, 1 failures, 3 abstained (zero checks verified). */
  exitCode: number;
}

/**
 * No silent abstention (#505/#508): fold check results into the summary line
 * and exit code. "Skipped" is reported next to "passed", never inside it, and
 * a run that verified zero checks abstains loudly (exit 3) instead of
 * printing "All checks passed."
 */
export function summarizeChecks(
  results: readonly CheckResult[],
): DoctorSummary {
  const count = (s: CheckStatus): number =>
    results.filter((r) => r.status === s).length;
  const passed = count('pass');
  const failed = count('fail');
  const skipped = count('skip');
  const checked = passed + failed;
  const abstained = failed === 0 && checked === 0;

  let line: string;
  let exitCode: number;
  if (failed > 0) {
    line = `${failed} check(s) failed.`;
    exitCode = 1;
  } else if (abstained) {
    line = `⚠ abstained: 0 checks were verified (${skipped} skipped) — this is not a pass.`;
    exitCode = 3;
  } else if (skipped > 0) {
    line = `${passed} check(s) passed (${skipped} skipped).`;
    exitCode = 0;
  } else {
    line = 'All checks passed.';
    exitCode = 0;
  }
  return { passed, failed, skipped, checked, abstained, line, exitCode };
}

const SYMBOL: Record<CheckStatus, string> = {
  pass: '✓',
  fail: '✗',
  skip: '-',
  info: 'ℹ',
};

/** `--json` requests machine output on stdout instead of the human report. */
export function parseJsonFlag(args: readonly string[]): boolean {
  return args.includes('--json');
}

/**
 * `--audience <tag>` / `--audience=<tag>`, or null when unset (#319 B). The
 * former name `--persona` is accepted as a legacy alias so existing invocations
 * keep working; `--audience` is canonical. (Renamed to end the collision with
 * harness's unrelated persona system.)
 */
function parseAudience(args: readonly string[]): string | null {
  for (const flag of ['--audience', '--persona']) {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === flag) {
        return args[i + 1] ?? null;
      }
      if (a.startsWith(`${flag}=`)) {
        return a.slice(flag.length + 1);
      }
    }
  }
  return null;
}

/**
 * Fail-loud hint for an unrecognized `--audience` value (issue #294). Returns
 * null when there is nothing to say — no audience was passed, or the passed
 * audience is part of the known vocabulary. Otherwise returns a one-line,
 * actionable message: the engine ships no audience vocabulary, so this lists
 * the tags overlays actually declared (or says none are defined) instead of
 * silently running only the audience-less checks and leaving the user to
 * guess why their filter matched nothing.
 */
export function unknownAudienceHint(
  audience: string | null,
  known: readonly string[],
): string | null {
  if (audience === null) {
    return null;
  }
  const want = audience.toLowerCase();
  if (known.some((p) => p.toLowerCase() === want)) {
    return null;
  }
  if (known.length === 0) {
    return `--audience '${audience}' matched no checks: no overlay defines any audiences, so every check already runs. Drop the flag.`;
  }
  return `--audience '${audience}' is not a known audience. Valid options: ${known.join(', ')}. (Omit --audience to run every check.)`;
}

function renderCheck(r: CheckResult): string {
  const line = `  ${SYMBOL[r.status]} ${r.label}\n`;
  return r.status === 'fail' && r.remedy
    ? `${line}      → ${r.remedy}\n`
    : line;
}

/** Load, audience-filter, and run one overlay's manifest checks. */
async function overlayResults(
  entry: registry.OverlayEntry,
  deps: DoctorDeps,
  audience: string | null,
): Promise<{ group: CheckGroup; loadedChecks: ManifestCheck[] }> {
  const header = `Overlay: ${entry.name}`;
  const load = loadManifest(entry.path);
  if (!load.ok) {
    return { group: { header, results: [load.failure] }, loadedChecks: [] };
  }
  const granted = registry.consentGranted(
    entry,
    commandSucceedsHash(load.checks),
  );
  const checks = filterByAudience(load.checks, audience);
  const ctx = {
    cloneDir: entry.path,
    invocationDir: deps.cwd ?? process.cwd(),
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
  // audience vocabulary for a fail-loud hint on an unknown --audience.
  return { group: { header, results }, loadedChecks: load.checks };
}

/**
 * Run `canary doctor`. Returns a process exit code: 0 when at least one check
 * was verified and none failed, 1 when any check failed, 3 (abstained) when
 * zero checks were actually verified (#508 — a run that checked nothing is
 * not a pass). A malformed manifest for one overlay never blocks engine
 * checks or other overlays.
 */
export async function runDoctor(
  args: readonly string[],
  deps: DoctorDeps = {},
): Promise<number> {
  const out = deps.out ?? process.stdout;
  const audience = parseAudience(args);
  const homeDir = deps.homeDir ?? os.homedir();

  const engineDeps: EngineCheckDeps = {
    git: deps.git,
    homeDir,
    cwd: deps.cwd,
    currentVersion: deps.currentVersion,
    getLatestVersion: deps.getLatestVersion,
    timeoutMs: deps.timeoutMs,
  };

  const groups: CheckGroup[] = [
    { header: 'Engine', results: await runEngineChecks(engineDeps) },
  ];

  let reg: registry.OverlayRegistry;
  try {
    reg = registry.read(homeDir);
  } catch {
    reg = registry.emptyRegistry();
  }
  const allChecks: ManifestCheck[] = [];
  for (const entry of reg.overlays) {
    const { group, loadedChecks } = await overlayResults(entry, deps, audience);
    groups.push(group);
    allChecks.push(...loadedChecks);
  }

  // Issue #294: if the user passed a --audience that no overlay declares,
  // tell them the valid vocabulary instead of silently filtering to only
  // the audience-less checks and leaving them to wonder why.
  const audienceHint = unknownAudienceHint(
    audience,
    collectAudiences(allChecks),
  );

  const summary = summarizeChecks(groups.flatMap((g) => g.results));

  // Issue #318: `--json` emits the canary-owned machine contract instead of
  // the human report — nothing else is written to stdout, so the whole stream
  // parses as one JSON object.
  if (parseJsonFlag(args)) {
    const report: JsonReport = {
      version: 1,
      checks: groups.flatMap((g) =>
        g.results.map((r) => ({
          id: r.id,
          status: r.status,
          label: r.label,
          ...(r.remedy !== undefined ? { remedy: r.remedy } : {}),
          group: g.header,
        })),
      ),
      allPassed: summary.exitCode === 0,
      checked: summary.checked,
      skipped: summary.skipped,
      abstained: summary.abstained,
      warnings: audienceHint ? [audienceHint] : [],
    };
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    return summary.exitCode;
  }

  out.write('canary doctor\n');
  if (audienceHint) {
    out.write(`\n! ${audienceHint}\n`);
  }
  for (const group of groups) {
    out.write(`\n${group.header}\n`);
    for (const result of group.results) {
      out.write(renderCheck(result));
    }
  }
  out.write(`\n${summary.line}\n`);
  return summary.exitCode;
}
