/**
 * Shared injectable dependencies + glyph constants for the main `canary` CLI
 * and its inline sub-apps (skills / workflow / company-knowledge).
 *
 * Every command reaches the outside world through {@link MainDeps} so tests run
 * with capturing sinks, a fixed env/cwd/home, and fake class factories -- the
 * commander analog of the Python CLI tests' `mock.patch(...)` seams. The
 * production {@link defaultMainDeps} wires process-backed real classes.
 *
 * Output glyphs are declared as `\u{...}` escapes (ASCII-source rule) and
 * emitted verbatim; picocolors strips its color on a non-TTY sink so the plain
 * text matches rich's markup stripping byte-for-byte (see `guardian/cli.ts`).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { TestClassifier } from './core/classifier.js';
import { CompanyKnowledge } from './core/company-knowledge.js';
import { CanaryTestExecutor } from './core/executor.js';
import { FrameworkRegistry } from './core/framework-registry.js';
import { HarnessMigrator } from './core/migrator.js';
import { PatternHealer } from './core/pattern-healer.js';
import { FrameworkRecommender } from './core/recommender.js';
import { Scaffolder } from './core/scaffolder.js';
import { SkillRegistry } from './core/skill-registry.js';
import { StaticLinter } from './core/static-linter.js';
import { TicketUpdater } from './core/ticket-updater.js';
import { WorkflowDiscovery } from './core/workflow-discovery.js';

// --- output glyphs (emitted verbatim; see module docstring) -------------------
export const CHECK_MARK = '\u{2705}'; // white heavy check mark
export const WARN = '\u{26a0}'; // warning sign
export const CROSS = '\u{2717}'; // ballot X
export const ROCKET = '\u{1f680}';
export const HAMMER = '\u{1f6e0}';
export const NEXT = '\u{23ed}\u{fe0f}'; // next-track button + VS16
export const REDX = '\u{274c}'; // cross mark
export const WRENCH = '\u{1f527}';
export const MAGNIFIER = '\u{1f50d}';
export const CHECK = '\u{2713}'; // light check mark
export const ARROW = '\u{2192}'; // rightwards arrow
export const EM_DASH = '\u{2014}';
export const ELLIPSIS = '\u{2026}';

/** Result of a shelled subprocess (`spawnSync`-shaped; status null == missing). */
export interface SubprocessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Every outside-world seam the main CLI and its sub-apps use. */
export interface MainDeps {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  cwd(): string;
  home(): string;
  /** Installed package version; may throw (Python `PackageNotFoundError`). */
  pkgVersion(): string;
  openBrowser(url: string): void;
  runSubprocess(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; inherit?: boolean },
  ): SubprocessResult;
  /** Interactive line prompt (typer.prompt analog): returns input or `def`. */
  prompt(text: string, def: string): string;
  pythonExe(): string;

  // class/factory seams (Python's import-then-instantiate, made injectable)
  makeClassifier(): TestClassifier;
  makeRecommender(): FrameworkRecommender;
  makeRegistry(): FrameworkRegistry;
  makeExecutor(): CanaryTestExecutor;
  makeScaffolder(): Scaffolder;
  makeMigrator(): HarnessMigrator;
  makeLinter(): StaticLinter;
  makeHealer(): PatternHealer;
  makeSkillRegistry(): SkillRegistry;
  makeWorkflowDiscovery(): WorkflowDiscovery;
  makeTicketUpdater(): TicketUpdater;
  loadCompanyKnowledge(env: string | null): CompanyKnowledge;
}

/** A stdin-backed prompt: reads piped lines once, returns `def` when exhausted. */
function makeStdinPrompt(): (text: string, def: string) => string {
  let lines: string[] | null = null;
  let idx = 0;
  return (_text: string, def: string): string => {
    if (lines === null) {
      try {
        lines = readFileSync(0, 'utf-8').split('\n');
      } catch {
        lines = [];
      }
    }
    const raw = idx < lines.length ? lines[idx++]! : '';
    return raw === '' ? def : raw;
  };
}

/** Process-backed defaults for production. */
export function defaultMainDeps(): MainDeps {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
    cwd: () => process.cwd(),
    home: () => homedir(),
    // The npm bin injects the real package version; the bare factory default
    // reports 'unknown' (Python's PackageNotFoundError fallback shape).
    pkgVersion: () => 'unknown',
    openBrowser: () => {
      // Best-effort no-op default; a desktop launcher is wired by the bin.
    },
    runSubprocess: (cmd, args, opts = {}) => {
      const res = spawnSync(cmd, args, {
        encoding: 'utf-8',
        maxBuffer: Infinity,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.inherit ? { stdio: 'inherit' as const } : {}),
      });
      if (res.error) return { status: null, stdout: '', stderr: '' };
      return {
        status: res.status,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
      };
    },
    prompt: makeStdinPrompt(),
    pythonExe: () => 'python3',
    makeClassifier: () => new TestClassifier(),
    makeRecommender: () => new FrameworkRecommender(),
    makeRegistry: () => new FrameworkRegistry(),
    makeExecutor: () => new CanaryTestExecutor(),
    makeScaffolder: () => new Scaffolder(),
    makeMigrator: () => new HarnessMigrator(),
    makeLinter: () => new StaticLinter(),
    makeHealer: () => new PatternHealer(),
    makeSkillRegistry: () => new SkillRegistry(),
    makeWorkflowDiscovery: () => new WorkflowDiscovery(),
    makeTicketUpdater: () => new TicketUpdater(),
    loadCompanyKnowledge: (env) => CompanyKnowledge.load(undefined, env),
  };
}
