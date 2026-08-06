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
import {
  EXIT_ABSTAINED,
  gateOutcome,
  skippedSuffix,
  type SkipEntry,
} from './gate-result.js';

export { EXIT_ABSTAINED };

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
  /**
   * Override the engine check set. A test seam only: it is the one input a
   * hermetic run cannot control (engine checks read the real environment), and
   * the abstention fixtures need a run whose denominator is exactly zero.
   */
  runEngineChecks?: (deps: EngineCheckDeps) => Promise<CheckResult[]>;
}

/** One printed section: a header and its check results. */
export interface CheckGroup {
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
  /** True iff no check failed — mirrors `harness doctor --json`'s one shared field. */
  allPassed: boolean;
  /** Non-fatal advisories (e.g. an unknown `--audience`); empty when none. */
  warnings: string[];
  /** Checks that produced a verdict (`pass + fail`) -- the denominator (#508). */
  checked: number;
  /** Skipped checks, always reported; never folded into `allPassed` (D7). */
  skipped: SkipEntry[];
  /** True when nothing was verified: `allPassed` is false and the exit is 3. */
  abstained: boolean;
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

/** Doctor's denominator, and the decision that follows from it (#508 D7). */
export interface DoctorSummary {
  /** Checks that actually produced a verdict: `pass + fail`. */
  checked: number;
  passed: number;
  failed: number;
  /** Every skipped check, always visible, never folded into `passed`. */
  skipped: SkipEntry[];
  abstained: boolean;
  exitCode: number;
  summaryLine: string;
}

/**
 * Compute doctor's denominator and summary line (#508 Wave 3, D7 / #505).
 *
 * Doctor used to count only failures, so a run in which EVERY check was
 * skipped printed `All checks passed.` and exited 0 -- the doctrine violation
 * that started #508. Here the denominator is explicit: `info` results are not
 * verifications (they report context, not evidence), so a run with nothing but
 * skips and info abstains.
 *
 * The decision (exit code + `abstained`) comes from `gateOutcome` and is never
 * re-derived here; only the failure line keeps doctor's own vocabulary
 * ("check(s) failed" rather than "finding(s)"), rendered with the helper's own
 * skip suffix so the two can never drift.
 */
export function summarizeChecks(groups: readonly CheckGroup[]): DoctorSummary {
  const results = groups.flatMap((g) => g.results);
  const failures = results.filter((r) => r.status === 'fail');
  const passed = results.filter((r) => r.status === 'pass').length;
  const skipped: SkipEntry[] = results
    .filter((r) => r.status === 'skip')
    .map((r) => ({ name: r.id, reason: r.remedy ?? r.label }));
  const checked = passed + failures.length;

  const outcome = gateOutcome({ checked, findings: failures, skipped }, 'gate');
  return {
    checked,
    passed,
    failed: failures.length,
    skipped,
    abstained: outcome.abstained,
    exitCode: outcome.exitCode,
    summaryLine:
      failures.length > 0
        ? `${failures.length} check(s) failed${skippedSuffix(skipped)}`
        : outcome.summaryLine,
  };
}

/**
 * Remediation for an abstained run: why the denominator collapsed, and the
 * first fix step. Required of every abstaining surface (spec: "an abstaining
 * surface must say _why_ ... and the first fix step").
 */
function abstentionRemedy(summary: DoctorSummary): string {
  return summary.skipped.length > 0
    ? // #505: `<source>`, not `<name>` -- `add` takes the source spec, so the
      // copied-and-pasted form failed for anyone who followed it literally.
      'Every registered check was skipped or informational, so doctor verified ' +
        'nothing. Grant command-check consent (re-run `canary overlay add ' +
        '<source> --yes`, which re-asks consent on an already-installed overlay ' +
        'without re-cloning) or install an overlay whose checks apply here, ' +
        'then re-run.'
    : 'No check was registered, so doctor verified nothing. Install an ' +
        'overlay that ships a `.canary/doctor.json` (`canary overlay add ' +
        '<source>`), then re-run.';
}

/**
 * Run `canary doctor`. Returns a process exit code: 0 when at least one check
 * ran and none failed, 1 when any check failed, and `EXIT_ABSTAINED` (3) when
 * nothing was actually verified (#508). A malformed manifest for one overlay
 * never blocks engine checks or other overlays.
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

  const engineChecks = deps.runEngineChecks ?? runEngineChecks;
  const groups: CheckGroup[] = [
    { header: 'Engine', results: await engineChecks(engineDeps) },
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

  // #508: the denominator, not just the failure count. `summarizeChecks` is
  // the only path to a summary line and an exit code, so doctor structurally
  // cannot print a bare success over zero verified checks.
  const summary = summarizeChecks(groups);

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
      // #508: an abstained run is NOT "all passed" -- zero verified checks is
      // an absent measurement, never a green.
      allPassed: summary.failed === 0 && !summary.abstained,
      warnings: audienceHint ? [audienceHint] : [],
      checked: summary.checked,
      skipped: summary.skipped,
      abstained: summary.abstained,
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
  out.write(`\n${summary.summaryLine}\n`);
  if (summary.abstained) {
    out.write(`  ${abstentionRemedy(summary)}\n`);
  }
  return summary.exitCode;
}
