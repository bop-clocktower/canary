/**
 * CLI subcommands for `canary guardian`.
 *
 * Faithful TypeScript port of `agent/guardian/cli.py` -- the FIRST commander CLI
 * in the repo, establishing the pattern the later main-cli port follows:
 *
 *   - A **factory** {@link createGuardianCommand} builds a fresh `commander`
 *     `Command` wired to an injectable {@link GuardianDeps} (stdout/stderr sinks,
 *     stdin, env, git/gh runners, network client factories). The production
 *     export {@link guardianCommand} uses process-backed defaults; tests build a
 *     command with capturing sinks and fake clients -- no global monkeypatching,
 *     no network. This is exactly how Python's `_build_client` /
 *     `_branch_protection_client` seams were replaced.
 *   - Commands are THIN: parse -> call the already-ported guardian library ->
 *     emit. No business logic lives in a handler.
 *   - Business exit codes are carried by throwing {@link CliExit} (Python's
 *     `typer.Exit(n)`); `parseAsync` from a test catches it to read the code.
 *     `.exitOverride()` turns commander's own usage errors into throws too, so a
 *     test never terminates the process.
 *
 * Command surface (kebab-case names, matching the shipping Typer CLI):
 *   analyze | validate-coverage | harden-gate | pr-check | author-plan |
 *   mark-authored | watch.
 *
 * Python->TS nuances honored:
 *   - `json.dumps(obj, indent=2)` -> `ensureAscii(JSON.stringify(obj, null, 2))`
 *     (indent-2 matches Python's `(', ', ': ')` separators byte-for-byte;
 *     `ensureAscii` restores the `ensure_ascii=True` default).
 *   - `rich.print("[green]x[/green]")` -> `pc.green('x')`. picocolors strips
 *     color when stdout is not a TTY (tests), so the plain text is byte-exact --
 *     the same way rich strips markup for a non-terminal sink. INTENTIONAL
 *     DEVIATION: rich also soft-wraps prose at 80 cols on a non-TTY sink; this
 *     port does NOT wrap. Content is identical; only newline placement differs
 *     for long human-readable lines. Notably this makes `analyze --json` emit
 *     VALID JSON here, whereas rich can wrap a long value mid-array and produce
 *     invalid JSON in Python -- we deliberately do not replicate that bug.
 *   - `typer.echo(x)` -> `deps.out(x)` (stdout); `typer.echo(x, err=True)` ->
 *     `deps.err(x)` (stderr).
 *   - non-ASCII output data (em-dash, arrows, check/cross glyphs) is written as
 *     `\u{...}` escapes to honor the ASCII-source rule, then emitted verbatim.
 *   - `subprocess.run(...)` -> `spawnSync(..., { maxBuffer: Infinity })` behind
 *     `deps.runGit`/`deps.runGh`, returning `null` on a missing binary (the
 *     Python `OSError`/`FileNotFoundError` fail-safe path).
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { Command, CommanderError, Option } from 'commander';
import { load as loadYaml } from 'js-yaml';
import pc from 'picocolors';

import {
  AgentTier,
  AuthoringContext,
  GeneratedTest,
  InSessionAgentProbe,
  InSessionAgentTier,
  decideBlock,
} from './agent-tier.js';
import { emitAnalysis } from './analysis-emit.js';
import { resolveCoverage, validateCoverageJson } from './coverage.js';
import { buildApiDelta, writeApiDelta } from './delta-emitter.js';
import { extractApiDiff } from './diff-extractor.js';
import {
  BranchProtection,
  HardGateBlocked,
  RestBranchProtectionClient,
  applyHardGate,
  renderPlaybook,
} from './hard-gate.js';
import { CoverageRow, mapImpact } from './impact-mapper.js';
import {
  Finding,
  GuardianConfig,
  applySuppressions,
  buildFindings,
  buildWeakTestFindings,
  computeExitCode,
  effectiveGraphDepth,
  filterSkipped,
  filterTestUnits,
  findReexportOnly,
  loadGuardianConfig,
  render,
  scopeDiff,
} from './pr-check.js';
import {
  GitHubClient,
  RestGitHubClient,
  degradationAnnotation,
  upsertStickyComment,
} from './pr-comment.js';
import { buildSummary } from './summary-emitter.js';
import { TierResolution, resolveTier } from './tier.js';

// --- Output data glyphs (load-bearing; emitted verbatim, ASCII-escaped source).
const EM_DASH = '\u{2014}';
const RIGHT_ARROW = '\u{2192}';
const CHECK = '\u{2713}';
const CROSS = '\u{2717}';

/**
 * Business exit signal. Thrown from a handler to carry an exit code the way
 * Python's `typer.Exit(code)` did; the runner catches it to read the code.
 */
export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'CliExit';
  }
}

/**
 * Normalize commander's usage-error exit code to typer/click's `2`. Commander
 * defaults usage errors (unknown/missing option, bad command, no-args help) to
 * exit 1; typer uses 2, so a script checking `$? -eq 2` for bad usage would
 * otherwise break. Explicit `--help`/`--version` exit 0 in BOTH, so leave those.
 * Used as the `.exitOverride()` callback on the program and every subcommand.
 */
function normalizeUsageExit(err: CommanderError): never {
  if (
    err.code !== 'commander.helpDisplayed' &&
    err.code !== 'commander.version'
  ) {
    err.exitCode = 2;
  }
  throw err;
}

/** Raised by `deps.sleep` to break the `watch` poll loop (Ctrl+C analog). */
export class WatchInterrupt extends Error {
  constructor() {
    super('watch interrupted');
    this.name = 'WatchInterrupt';
  }
}

/** Result of a shelled `git` call. `null` models a missing binary (OSError). */
export interface GitResult {
  code: number;
  stdout: string;
}

/** Result of a shelled `gh` call. */
export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  failed: boolean; // binary missing / timed out (Python FileNotFoundError/Timeout)
}

/**
 * Everything the CLI reaches the outside world through -- injected so tests run
 * with capturing sinks, a fixed env, and fake clients (no network, no real git).
 */
export interface GuardianDeps {
  out(s: string): void; // stdout line (a trailing newline is added)
  err(s: string): void; // stderr line
  readStdin(): string;
  env: NodeJS.ProcessEnv;
  cwd(): string;
  runGit(args: string[], cwd?: string): GitResult | null;
  runGh(args: string[]): GhResult;
  buildCommentClient(repo: string, prNumber: number): GitHubClient;
  buildBranchProtectionClient(repo: string, token: string): BranchProtection;
  makeAgentTier(): AgentTier;
  sleep(secs: number): Promise<void>;
}

/** Process-backed defaults for production (the `guardianCommand` export). */
export function defaultDeps(): GuardianDeps {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    readStdin: () => {
      try {
        return readFileSync(0, 'utf-8');
      } catch {
        return '';
      }
    },
    env: process.env,
    cwd: () => process.cwd(),
    runGit: (args, cwd) => {
      const res = spawnSync('git', args, {
        encoding: 'utf-8',
        maxBuffer: Infinity,
        ...(cwd ? { cwd } : {}),
      });
      if (res.error) return null; // missing binary -> Python OSError fail-safe
      return { code: res.status ?? 1, stdout: res.stdout ?? '' };
    },
    runGh: (args) => {
      const res = spawnSync('gh', args, {
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: Infinity,
      });
      if (res.error) {
        return { status: null, stdout: '', stderr: '', failed: true };
      }
      return {
        status: res.status,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
        failed: false,
      };
    },
    buildCommentClient: (repo, prNumber) =>
      new RestGitHubClient(repo, prNumber, process.env['GITHUB_TOKEN'] ?? ''),
    buildBranchProtectionClient: (repo, token) =>
      new RestBranchProtectionClient(repo, token),
    makeAgentTier: () => new InSessionAgentTier(),
    sleep: (secs) => new Promise((resolve) => setTimeout(resolve, secs * 1000)),
  };
}

/**
 * Escape non-ASCII to `\uXXXX`, matching Python `json.dumps(ensure_ascii=True)`.
 */
function ensureAscii(json: string): string {
  // Escape every UTF-16 code UNIT >= 0x80 to \uXXXX, matching Python
  // json.dumps(ensure_ascii=True). Iterating by unit (not code point) means an
  // astral char's surrogate pair emits \udXXX\udXXX, like Python; a code-point
  // regex would stop at U+FFFF and leave astral chars raw.
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    out += c >= 0x80 ? '\\u' + c.toString(16).padStart(4, '0') : json[i];
  }
  return out;
}

/** ISO-8601 UTC timestamp with a `+00:00` offset (Python `isoformat`-shaped). */
function isoUtcNow(): string {
  return new Date().toISOString().replace('Z', '+00:00');
}

// --- shared environment/git helpers (Python module-level `_*` functions) ------

/**
 * Resolve `(repo, pr_number)` from GitHub Actions env, else `null`.
 *
 * `repo` comes from `GITHUB_REPOSITORY` (`owner/repo`). The PR number is parsed
 * from `GITHUB_REF` (`refs/pull/<n>/merge`); when that is not a PR ref, it falls
 * back to the `pull_request.number` field of the event JSON at
 * `GITHUB_EVENT_PATH`. Returns `null` if either piece cannot be resolved.
 */
export function prContextFromEnv(
  env: NodeJS.ProcessEnv,
): [string, number] | null {
  const repo = env['GITHUB_REPOSITORY'];
  if (!repo || !repo.includes('/')) return null;

  const ref = env['GITHUB_REF'] ?? '';
  const match = /^refs\/pull\/(\d+)\//.exec(ref);
  if (match) return [repo, Number.parseInt(match[1]!, 10)];

  const eventPath = env['GITHUB_EVENT_PATH'];
  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf-8')) as unknown;
      const number =
        typeof event === 'object' && event !== null
          ? (event as { pull_request?: { number?: unknown } }).pull_request
              ?.number
          : undefined;
      if (typeof number === 'number' && Number.isInteger(number)) {
        return [repo, number];
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * At-desk fork signal (guard b), FAIL-CLOSED on ambiguity.
 *
 * Only two safe sentinels mean "not a fork": `CANARY_GUARDIAN_IS_FORK` UNSET, or
 * exactly `"0"` (after trim). ANY other non-empty value is treated as a fork, so
 * authoring is SKIPPED rather than fail-open writing to an untrusted checkout.
 */
export function isForkContext(env: NodeJS.ProcessEnv): boolean {
  const raw = env['CANARY_GUARDIAN_IS_FORK'];
  if (raw === undefined) return false;
  return raw.trim() !== '0';
}

/** Append `notice` to the `$GITHUB_STEP_SUMMARY` file when set (no-op else). */
function appendStepSummary(env: NodeJS.ProcessEnv, notice: string): void {
  const summaryPath = env['GITHUB_STEP_SUMMARY'];
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, `\n> ${notice}\n`, 'utf-8');
  } catch {
    // best-effort
  }
}

/**
 * Resolve the analyses record `<ref>`: PR number (`pr-<n>`) from CI env, else the
 * short HEAD sha, else `"local"`. Fails safe to `"local"` when `git` is absent.
 */
export function resolveAnalysisRef(deps: GuardianDeps): string {
  const ctx = prContextFromEnv(deps.env);
  if (ctx !== null) return `pr-${ctx[1]}`;
  const res = deps.runGit(['rev-parse', '--short', 'HEAD']);
  if (res === null) return 'local'; // missing binary -> fail-safe
  return res.stdout.trim() || 'local';
}

/** Resolve the repository root via `git rev-parse --show-toplevel`. */
function gitToplevel(deps: GuardianDeps): string {
  const res = deps.runGit(['rev-parse', '--show-toplevel']);
  if (res !== null && res.code === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return deps.cwd();
}

/** Resolve the real git dir for `root` via `git rev-parse --git-dir`. */
function gitDir(deps: GuardianDeps, root: string): string {
  const res = deps.runGit(['rev-parse', '--git-dir'], root);
  if (res !== null && res.code === 0 && res.stdout.trim()) {
    const resolved = res.stdout.trim();
    return isAbsolute(resolved) ? resolved : join(root, resolved);
  }
  return join(root, '.git');
}

const AUTHORED_SENTINEL_NAME = 'canary-guardian-authored';

/** Absolute path to the guardian's authored-tests sentinel under `root`. */
function authoredSentinelPath(deps: GuardianDeps, root: string): string {
  return join(gitDir(deps, root), AUTHORED_SENTINEL_NAME);
}

/**
 * Return raw unified-diff text from a source.
 *
 * `source === '-'` reads stdin; a path reads that file; `null` runs `git diff`
 * and falls back to `git diff --staged` when the worktree is clean.
 *
 * This is the AT-DESK resolution: the working tree is the subject. `pr-check`
 * uses {@link readPrDiff} instead, which prefers the PR diff in CI (#369).
 */
function readDiff(source: string | null, deps: GuardianDeps): string {
  if (source === '-') return deps.readStdin();
  if (source !== null) return readFileSync(source, 'utf-8');
  return readWorktreeDiff(deps);
}

/** `git diff`, falling back to `git diff --staged` on a clean worktree. */
function readWorktreeDiff(deps: GuardianDeps): string {
  const unstaged = deps.runGit(['diff'])?.stdout ?? '';
  if (unstaged.trim()) return unstaged;
  return deps.runGit(['diff', '--staged'])?.stdout ?? '';
}

/** Where an omitted-`--diff` resolution ended up (#369). */
export type DiffOrigin = 'stdin' | 'file' | 'ci-base' | 'worktree';

/** A resolved diff plus the provenance the caller needs to warn accurately. */
export interface ResolvedDiff {
  text: string;
  origin: DiffOrigin;
  /** The git rev the diff was taken against; only set for `ci-base`. */
  base: string | null;
}

/** True when the process looks like a CI runner rather than a dev worktree. */
function isCiContext(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['GITHUB_ACTIONS'] || env['CI']);
}

/** Read `pull_request.base.sha` from the Actions event payload, if present. */
function eventBaseSha(env: NodeJS.ProcessEnv): string | null {
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (!eventPath) return null;
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf-8')) as unknown;
    const sha =
      typeof event === 'object' && event !== null
        ? (event as { pull_request?: { base?: { sha?: unknown } } })
            .pull_request?.base?.sha
        : undefined;
    return typeof sha === 'string' && sha.trim() ? sha.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Base-rev candidates for the PR diff, most-preferred first.
 *
 * `origin/<ref>` leads because `actions/checkout` fetches the base branch under
 * the remote namespace and usually does NOT create a local branch for it; the
 * bare `<ref>` covers checkouts that do. The event payload's `base.sha` is the
 * last resort — exact, but only present on `pull_request` events.
 */
function baseRefCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const baseRef = env['GITHUB_BASE_REF']?.trim();
  if (baseRef) candidates.push(`origin/${baseRef}`, baseRef);
  const sha = eventBaseSha(env);
  if (sha) candidates.push(sha);
  return candidates;
}

/**
 * Return the first base candidate that actually resolves to a commit locally.
 *
 * A shallow clone (`fetch-depth: 1`, the `actions/checkout` default) will NOT
 * have the base commit, so every candidate fails `rev-parse` and we return
 * `null` — the caller then falls back to the worktree diff and warns.
 */
function resolveBaseRev(deps: GuardianDeps): string | null {
  for (const candidate of baseRefCandidates(deps.env)) {
    const res = deps.runGit([
      'rev-parse',
      '--verify',
      '--quiet',
      `${candidate}^{commit}`,
    ]);
    if (res !== null && res.code === 0 && res.stdout.trim()) return candidate;
  }
  return null;
}

/**
 * Resolve the diff `pr-check` should scope, preferring the PR diff in CI (#369).
 *
 * An explicit `--diff` (stdin or file) always wins and never shells out. With
 * `--diff` omitted:
 *
 *   - **In CI** with a resolvable base rev → `git diff <base>...HEAD`. The
 *     TRIPLE-dot form diffs against the merge base, so commits that land on the
 *     base branch mid-PR never appear as part of this PR's changed surface.
 *   - **Otherwise** → the at-desk working-tree diff ({@link readWorktreeDiff}).
 *
 * The legacy behavior was the working-tree diff unconditionally, which is empty
 * on a clean CI checkout — the gate then scoped zero paths and exited 0, so an
 * adopting repo could not tell a working gate from a broken one.
 */
export function readPrDiff(
  source: string | null,
  deps: GuardianDeps,
): ResolvedDiff {
  if (source === '-') {
    return { text: deps.readStdin(), origin: 'stdin', base: null };
  }
  if (source !== null) {
    return { text: readFileSync(source, 'utf-8'), origin: 'file', base: null };
  }
  if (isCiContext(deps.env)) {
    const base = resolveBaseRev(deps);
    if (base !== null) {
      const res = deps.runGit(['diff', `${base}...HEAD`]);
      if (res !== null && res.code === 0) {
        return { text: res.stdout, origin: 'ci-base', base };
      }
    }
  }
  return { text: readWorktreeDiff(deps), origin: 'worktree', base: null };
}

const EMPTY_CI_DIFF_NOTICE =
  'guardian: 0 changed paths — fell back to a working-tree `git diff`, which ' +
  'is empty on a clean CI checkout, so NOTHING was verified. Pass ' +
  '`--diff <base>...<head>`, or checkout with `fetch-depth: 0` so the PR base ' +
  'ref resolves automatically.';

/**
 * Warn LOUDLY when a CI run scoped zero paths off the worktree fallback (#369).
 *
 * Fires only for the exact broken shape — `--diff` omitted, CI detected, base
 * rev unresolvable, and zero changed paths. A diff that DID carry paths which
 * were then all skipped is a legitimate no-op and stays quiet.
 *
 * Deliberately non-blocking: it annotates (`::warning::` + step summary +
 * stderr) rather than exiting non-zero, so adopting an engine upgrade never
 * flips a green build red — but a silent green no-op becomes impossible.
 */
function warnIfEmptyCiDiff(
  resolved: ResolvedDiff,
  unitCount: number,
  deps: GuardianDeps,
): void {
  if (resolved.origin !== 'worktree') return;
  if (unitCount > 0) return;
  if (!isCiContext(deps.env)) return;
  deps.out(degradationAnnotation(EMPTY_CI_DIFF_NOTICE));
  appendStepSummary(deps.env, EMPTY_CI_DIFF_NOTICE);
  deps.err(EMPTY_CI_DIFF_NOTICE);
}

// --- analyze ------------------------------------------------------------------

function loadSpec(path: string, deps: GuardianDeps): Record<string, unknown> {
  if (!existsSync(path)) {
    deps.err(`Spec file not found: ${path}`);
    throw new CliExit(2);
  }
  const text = readFileSync(path, 'utf-8');
  // Python `_load_spec`: `.json` -> json.loads; otherwise yaml.safe_load (with a
  // json.loads fallback only if PyYAML is absent, which it isn't in practice).
  // YAML is a JSON superset, so js-yaml `load` parses .yaml/.yml OpenAPI specs
  // the oracle accepts. A parse error propagates (Python lets it raise too).
  if (path.endsWith('.json')) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return (loadYaml(text) ?? {}) as Record<string, unknown>;
}

function loadCoverage(path: string): CoverageRow[] {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const endpoints = (data as { endpoints?: unknown }).endpoints;
      return Array.isArray(endpoints) ? (endpoints as CoverageRow[]) : [];
    }
    return [];
  } catch {
    return [];
  }
}

function tryPostPrComment(
  summary: string,
  prUrl: string | undefined,
  deps: GuardianDeps,
): void {
  if (!prUrl) return;
  const result = deps.runGh(['pr', 'comment', prUrl, '--body', summary]);
  if (result.failed) return; // missing binary / timeout -> Python `pass`
  if (result.status === 0) {
    deps.out(pc.green('Posted impact summary as PR comment.'));
  } else {
    deps.out(
      `${pc.yellow('Could not post PR comment:')} ${result.stderr.trim()}`,
    );
  }
}

interface AnalyzeOptions {
  pr?: string;
  specBefore?: string;
  specAfter?: string;
  suite: string;
  coverage?: string;
  dryRun?: boolean;
  json?: boolean;
  emitDiff?: string;
  dbUrl?: string;
}

function analyzeCmd(
  commit: string | undefined,
  opts: AnalyzeOptions,
  deps: GuardianDeps,
): void {
  let beforeSpec: Record<string, unknown> = {};
  let afterSpec: Record<string, unknown> = {};
  if (!opts.specBefore || !opts.specAfter) {
    deps.out(
      `${pc.yellow('Tip:')} pass --spec-before and --spec-after to diff two OpenAPI specs.`,
    );
    deps.out(
      'Without spec files, guardian reports no diff (use for testing the pipeline).',
    );
  } else {
    beforeSpec = loadSpec(opts.specBefore, deps);
    afterSpec = loadSpec(opts.specAfter, deps);
  }

  const diff = extractApiDiff(beforeSpec, afterSpec);
  const sha = commit ?? 'unknown';

  if (opts.emitDiff) {
    const generated = isoUtcNow();
    writeApiDelta(
      buildApiDelta(diff, sha, opts.suite, generated),
      opts.emitDiff,
    );
    deps.out(
      `${pc.green('Wrote api-delta.json')} ${RIGHT_ARROW} ${opts.emitDiff}`,
    );
  }

  const coverageRows = opts.coverage ? loadCoverage(opts.coverage) : [];
  const gaps = mapImpact(diff, coverageRows);
  const summary = buildSummary(gaps, sha, opts.suite);

  if (opts.json) {
    deps.out(
      ensureAscii(
        JSON.stringify(
          {
            commit: sha,
            suite: opts.suite,
            added: diff.added.length,
            removed: diff.removed.length,
            changed: diff.changed.length,
            gaps: gaps.map((g) => ({
              path: g.path,
              method: g.method,
              change_type: g.change_type,
              severity: g.severity,
              affected_tests: g.affected_tests,
            })),
          },
          null,
          2,
        ),
      ),
    );
  } else {
    deps.out(summary);
  }

  if (!opts.dryRun && !opts.json) {
    tryPostPrComment(summary, opts.pr, deps);
  }
}

// --- validate-coverage --------------------------------------------------------

interface ValidateCoverageOptions {
  strict?: boolean;
  json?: boolean;
}

const MAX_COVERAGE_BYTES = 25 * 1024 * 1024;

function validateCoverageCmd(
  path: string,
  opts: ValidateCoverageOptions,
  deps: GuardianDeps,
): void {
  let text: string;
  try {
    const st = statSync(path);
    if (st.isDirectory() || st.size > MAX_COVERAGE_BYTES) {
      deps.out(
        `${pc.red(pc.bold(`${CROSS} cannot read ${path}:`))} not a readable file within the size limit`,
      );
      throw new CliExit(2);
    }
    text = readFileSync(path, 'utf-8');
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    const msg = exc instanceof Error ? exc.message : String(exc);
    deps.out(`${pc.red(pc.bold(`${CROSS} cannot read ${path}:`))} ${msg}`);
    throw new CliExit(2);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    deps.out(
      `${pc.red(pc.bold(`${CROSS} ${path} is not valid JSON:`))} ${msg}`,
    );
    throw new CliExit(2);
  }

  const problems = validateCoverageJson(data);
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const valid = errors.length === 0;

  if (opts.json) {
    // Plain stdout, NOT colored -- producer-controlled keys must not be
    // interpreted as markup, and the payload must stay valid JSON.
    deps.out(
      ensureAscii(
        JSON.stringify(
          {
            valid,
            problems: problems.map((pr) => ({
              severity: pr.severity,
              location: pr.location,
              message: pr.message,
            })),
          },
          null,
          2,
        ),
      ),
    );
  } else {
    for (const pr of errors) {
      deps.out(`${pc.red(pc.bold('error'))} ${pr.location}: ${pr.message}`);
    }
    for (const pr of warnings) {
      deps.out(`${pc.yellow('warning')} ${pr.location}: ${pr.message}`);
    }
    if (valid && warnings.length === 0) {
      deps.out(
        pc.green(
          pc.bold(`${CHECK} ${path} is a valid coverage-json document.`),
        ),
      );
    } else if (valid) {
      deps.out(
        `${pc.green(`${CHECK} valid`)} with ${warnings.length} warning(s) ${EM_DASH} coverage is usable but degraded.`,
      );
    } else {
      deps.out(
        `${pc.red(pc.bold(`${CROSS} invalid`))} ${EM_DASH} ${errors.length} error(s); this coverage would be dropped.`,
      );
    }
  }

  if (errors.length > 0 || (opts.strict && warnings.length > 0)) {
    throw new CliExit(1);
  }
}

// --- harden-gate --------------------------------------------------------------

interface HardenGateOptions {
  apply?: boolean;
  repo?: string;
  branch: string;
  check: string;
  token?: string;
  force?: boolean;
}

async function hardenGateCmd(
  opts: HardenGateOptions,
  deps: GuardianDeps,
): Promise<void> {
  const repo = opts.repo;
  if (!repo) {
    deps.out(
      `${pc.red(pc.bold(`${CROSS} no repo`))} ${EM_DASH} pass --repo owner/repo or set GITHUB_REPOSITORY.`,
    );
    throw new CliExit(2);
  }

  const playbook = renderPlaybook(repo, opts.branch, opts.check);

  if (!opts.apply) {
    deps.out(
      `${pc.bold('Dry run')} ${EM_DASH} would require the '${opts.check}' check on ${repo}@${opts.branch}.`,
    );
    deps.out(
      'On --apply this merges into existing protection (or creates minimal ' +
        'protection if the branch is unprotected) and first verifies the ' +
        `context is real. Re-run with ${pc.bold('--apply')} (needs an admin ` +
        'token), or do it manually:\n',
    );
    deps.out(playbook);
    return;
  }

  if (!opts.token) {
    deps.out(
      `${pc.red(pc.bold(`${CROSS} --apply needs an admin token`))} (pass --token or set GITHUB_TOKEN).\n`,
    );
    deps.out(playbook);
    throw new CliExit(2);
  }

  const client = deps.buildBranchProtectionClient(repo, opts.token);
  let plan;
  try {
    plan = await applyHardGate(
      client,
      repo,
      opts.branch,
      opts.check,
      opts.force ?? false,
    );
  } catch (exc) {
    if (exc instanceof HardGateBlocked) {
      deps.out(`${pc.red(pc.bold(`${CROSS} ${exc.reason}`))}\n`);
      deps.out(exc.playbook);
      throw new CliExit(1);
    }
    throw exc;
  }

  if (plan.already_required) {
    deps.out(
      pc.green(
        `${CHECK} '${opts.check}' is already required on ${repo}@${opts.branch} ${EM_DASH} nothing to do.`,
      ),
    );
  } else {
    const verb = plan.creates_protection
      ? 'created protection and required'
      : 'required';
    deps.out(
      pc.green(
        pc.bold(`${CHECK} ${verb} '${opts.check}' on ${repo}@${opts.branch}.`),
      ),
    );
  }
  deps.out(
    pc.dim(
      `Finish the flip: set the exit gate to hard too ${EM_DASH} ` +
        'canary.guardian.pr.gate = "hard" in harness.config.json ' +
        '(or run pr-check --gate hard).',
    ),
  );
}

// --- pr-check -----------------------------------------------------------------

/**
 * Upsert the Phase-2 sticky PR comment (behavior-preserving extraction). When no
 * PR context is resolvable from env, prints the body instead of crashing; a
 * read-only-token degradation is surfaced LOUDLY.
 */
async function postStickyComment(
  findings: Finding[],
  resolution: TierResolution,
  deps: GuardianDeps,
): Promise<void> {
  const body = render(
    findings,
    'comment',
    resolution.effective,
    resolution.degraded_notice,
  );
  const ctx = prContextFromEnv(deps.env);
  if (ctx === null) {
    deps.out(`guardian: no PR context in env ${EM_DASH} printing instead.`);
    deps.out(body);
    return;
  }
  const client = deps.buildCommentClient(ctx[0], ctx[1]);
  const res = await upsertStickyComment(client, body);
  if (res.action === 'degraded' && res.notice) {
    deps.out(degradationAnnotation(res.notice));
    appendStepSummary(deps.env, res.notice);
  }
}

interface PrCheckOptions {
  diff?: string;
  coverage?: string;
  format: string;
  config: string;
  gate?: string;
  postComment?: boolean;
  emitAnalysis?: boolean;
  analysesDir?: string;
}

async function prCheckCmd(
  opts: PrCheckOptions,
  deps: GuardianDeps,
): Promise<void> {
  const [config, warning] = loadGuardianConfig(opts.config);
  if (warning !== null) {
    // SC-8: surface the malformed-config warning loudly, never silently.
    deps.err(`WARNING: ${warning}`);
  }

  // OT-5: while pr.enabled == false, `--post-comment` skips the PR surface
  // entirely (no diff scoped, no comment posted, exit 0).
  if (opts.postComment && !config.pr_enabled) {
    deps.out(`guardian: pr.enabled is false ${EM_DASH} skipping PR surface.`);
    throw new CliExit(0);
  }

  const effectiveGate = opts.gate ?? config.pr_gate;

  // #369: in CI an omitted `--diff` resolves the PR diff from the base ref;
  // the working-tree fallback is empty on a clean checkout.
  const resolvedDiff = readPrDiff(opts.diff ?? null, deps);
  const diffText = resolvedDiff.text;
  const units = scopeDiff(diffText);
  warnIfEmptyCiDiff(resolvedDiff, units.length, deps);

  // SC-2: drop docs/config-only units matching skipGlobs.
  const [keptSkip, skipped] = filterSkipped(units, config.skip_globs);
  // FIX A: drop test-path units -- a test does not itself need a test.
  const [keptTest, testUnits] = filterTestUnits(keptSkip);
  // FIX 2: drop pure re-export/barrel files.
  const reexportPaths = findReexportOnly(diffText);
  const barrelUnits = keptTest.filter((u) => reexportPaths.has(u.path));
  const kept = keptTest.filter((u) => !reexportPaths.has(u.path));

  // Advisory weak-test findings for added tests that assert nothing.
  const weakFindings = config.weak_tests
    ? buildWeakTestFindings(testUnits, diffText)
    : [];

  if (kept.length === 0 && weakFindings.length === 0) {
    deps.out(
      `guardian: nothing to verify ` +
        `(${skipped.length + testUnits.length + barrelUnits.length} path(s) skipped).`,
    );
    throw new CliExit(0);
  }

  const results = resolveCoverage(kept, {
    coveragePath: opts.coverage ?? null,
    // #320: under a hard gate the graph tier requires a DIRECT test->source edge
    // (depth 1); soft stays unbounded. An explicit config value wins.
    graphMaxDepth: effectiveGraphDepth(config, effectiveGate),
  });
  const findings = [
    ...applySuppressions(buildFindings(results)),
    ...weakFindings,
  ];

  // SC-5 (PR half): resolve the requested tier against actual capability. No
  // agent runtime exists (default NoAgentProbe), so any `pr.tier > 0` drops to
  // tier 0 with a LOUD degradation notice.
  const resolution = resolveTier(config.pr_tier);
  if (resolution.degraded_notice) {
    deps.out(degradationAnnotation(resolution.degraded_notice));
    appendStepSummary(deps.env, resolution.degraded_notice);
  }

  // Compute the gate result once, up front: the emitted record carries it and it
  // is the process exit at the end (SC-4 -- emit never changes the exit logic).
  const exitCode = computeExitCode(findings, effectiveGate);

  let commentPosted = false;
  if (opts.emitAnalysis) {
    // SC-10 producer half: write ONE record to the analyses channel. On an
    // unavailable channel `emitAnalysis` returns a LOUD notice and we fall back
    // to the sticky comment -- the record is never silently dropped.
    const analysesDir = opts.analysesDir
      ? opts.analysesDir
      : join(gitToplevel(deps), '.harness', 'analyses');
    const res = emitAnalysis(findings, {
      analysesDir,
      ref: resolveAnalysisRef(deps),
      gate: effectiveGate,
      effective_tier: resolution.effective,
      degraded_notice: resolution.degraded_notice,
      exit_code: exitCode,
    });
    if (res.action === 'emitted') {
      deps.out(`guardian: wrote analysis record ${RIGHT_ARROW} ${res.path}`);
    } else {
      // LOUD fallback: `::warning::` + step-summary + stderr, then the Phase-2
      // sticky comment so findings stay visible (SC-10 fallback).
      deps.out(degradationAnnotation(res.notice!));
      appendStepSummary(deps.env, res.notice!);
      deps.err(res.notice!);
      await postStickyComment(findings, resolution, deps);
      commentPosted = true;
    }
  }

  if (opts.postComment && !commentPosted) {
    // Explicit `--post-comment`: post/upsert unless the SC-10 fallback already
    // posted this run.
    await postStickyComment(findings, resolution, deps);
  } else if (!opts.emitAnalysis && !opts.postComment) {
    // Local, non-posting default: render to stdout in `--format`.
    deps.out(
      render(
        findings,
        opts.format,
        resolution.effective,
        resolution.degraded_notice,
      ),
    );
  }

  throw new CliExit(exitCode);
}

// --- author-plan --------------------------------------------------------------

/**
 * Build Tier-0 `untested-new-code` findings from `diffText` using the SAME
 * pipeline as `pr-check` (scope -> skip/test/re-export filters -> resolve
 * coverage -> build/suppress findings). Agent-free (SC-11).
 */
function buildGaps(
  diffText: string,
  config: GuardianConfig,
  coveragePath: string | null,
  graphMaxDepth: number | null,
): Finding[] {
  const units = scopeDiff(diffText);
  const [keptSkip] = filterSkipped(units, config.skip_globs);
  const [keptTest] = filterTestUnits(keptSkip);
  const reexportPaths = findReexportOnly(diffText);
  const kept = keptTest.filter((u) => !reexportPaths.has(u.path));
  if (kept.length === 0) return [];
  const results = resolveCoverage(kept, { coveragePath, graphMaxDepth });
  return applySuppressions(buildFindings(results));
}

/** Serialize a {@link GeneratedTest} intent for the SKILL (JSON-safe). */
function intentDict(intent: GeneratedTest): Record<string, unknown> {
  return {
    path: intent.gap.path,
    unit: intent.gap.unit,
    target_path: intent.target_path,
    requirement: intent.requirement,
    status: intent.status,
    written_path: intent.written_path,
    skip_reason: intent.skip_reason,
  };
}

interface AuthorPlanOptions {
  diff?: string;
  coverage?: string;
  config: string;
  json?: boolean;
}

function authorPlanCmd(opts: AuthorPlanOptions, deps: GuardianDeps): void {
  const [config, warning] = loadGuardianConfig(opts.config);
  if (warning !== null) {
    deps.err(`WARNING: ${warning}`);
  }

  const diffText = readDiff(opts.diff ?? null, deps);
  const gaps = buildGaps(
    diffText,
    config,
    opts.coverage ?? null,
    // #320: author-plan is the pre-commit authoring surface -- use the same
    // gate-derived graph depth the pre-commit hook computes (preCommit.gate).
    effectiveGraphDepth(config, config.precommit_gate),
  );

  const requested = config.precommit_author_tests ? 2 : 0;
  const effective = resolveTier(
    requested,
    new InSessionAgentProbe(deps.env),
  ).effective;

  // FIX 6: resolve the repo root from the git top-level (not cwd), so the
  // collision check and sentinel lookup stay root-relative from a subdirectory.
  const repoRoot = gitToplevel(deps);
  const ctx = new AuthoringContext(config.precommit_author_tests, effective, {
    is_fork: isForkContext(deps.env),
    repo_root: repoRoot,
    authored_sentinel_present: existsSync(authoredSentinelPath(deps, repoRoot)),
  });
  const results = deps.makeAgentTier().author_tests(gaps, ctx);
  const decision = decideBlock(results);
  const payload = {
    intents: results.map(intentDict),
    block: {
      block: decision.block,
      message: decision.message,
      authored_count: decision.authored_count,
    },
  };
  deps.out(ensureAscii(JSON.stringify(payload, null, 2)));
}

// --- mark-authored ------------------------------------------------------------

interface MarkAuthoredOptions {
  path: string[];
}

function markAuthoredCmd(opts: MarkAuthoredOptions, deps: GuardianDeps): void {
  const root = gitToplevel(deps);
  const sentinel = authoredSentinelPath(deps, root);
  mkdirSync(dirname(sentinel), { recursive: true });
  const body = opts.path.map((p) => `${p}\n`).join('');
  writeFileSync(sentinel, body, 'utf-8');
  deps.out(
    `guardian: recorded ${opts.path.length} authored path(s) ${RIGHT_ARROW} ${sentinel}`,
  );
}

// --- watch --------------------------------------------------------------------

interface WatchOptions {
  interval: number;
  suite: string;
  dbUrl?: string;
}

async function watchCmd(opts: WatchOptions, deps: GuardianDeps): Promise<void> {
  deps.out(
    `${pc.cyan('Guardian watch mode')} ${EM_DASH} polling every ${opts.interval}s. Ctrl+C to stop.`,
  );
  try {
    for (;;) {
      deps.out(pc.dim('Polling for new merges...'));
      await deps.sleep(opts.interval);
    }
  } catch (exc) {
    if (exc instanceof WatchInterrupt) {
      deps.out(`\n${pc.yellow('Watch stopped.')}`);
      return;
    }
    throw exc;
  }
}

// --- assembly -----------------------------------------------------------------

/** Collect a repeatable option value into an array (commander pattern). */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Build a fresh `guardian` command wired to `depsInit` (process-backed defaults
 * fill any gap). Every subcommand uses `.exitOverride()` so a usage error throws
 * a `CommanderError` rather than terminating the process -- tests read the exit
 * code from the thrown error (or from {@link CliExit} for business exits).
 */
export function createGuardianCommand(
  depsInit: Partial<GuardianDeps> = {},
): Command {
  const deps: GuardianDeps = { ...defaultDeps(), ...depsInit };

  const program = new Command('guardian');
  program
    .description('Watch API changes and analyze test impact.')
    .exitOverride(normalizeUsageExit);

  program
    .command('analyze')
    .description(
      'Analyze API diff for a commit and emit a test impact summary.',
    )
    .argument('[commit]', 'Commit SHA to analyze.')
    .option('--pr <pr>', 'GitHub PR URL to analyze.')
    .option('--spec-before <path>', 'Path to OpenAPI spec before the change.')
    .option('--spec-after <path>', 'Path to OpenAPI spec after the change.')
    .addOption(
      new Option('-s, --suite <suite>', 'Test suite name.').default('api'),
    )
    .option('--coverage <path>', 'Path to coverage-report.json.')
    .option('--dry-run', 'Print summary to stdout only.')
    .option('--json')
    .option(
      '--emit-diff <path>',
      'Write a machine-readable api-delta.json to PATH.',
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .action((commit: string | undefined, opts: AnalyzeOptions) => {
      analyzeCmd(commit, opts, deps);
    });

  program
    .command('validate-coverage')
    .description('Validate a coverage-json file against the producer contract.')
    .argument('<path>', 'Path to a coverage-json file to validate.')
    .option('--strict', 'Treat warnings as failures (exit 1).')
    .option('--json', 'Emit problems as JSON.')
    .action((path: string, opts: ValidateCoverageOptions) => {
      validateCoverageCmd(path, opts, deps);
    });

  program
    .command('harden-gate')
    .description(
      'Promote the guardian gate to hard (require its status check).',
    )
    .option('--apply', 'Register the required check (default: dry-run).')
    .addOption(
      new Option('--repo <repo>', 'owner/repo.').env('GITHUB_REPOSITORY'),
    )
    .addOption(
      new Option('--branch <branch>', 'Branch to protect.').default('main'),
    )
    .addOption(
      new Option(
        '--check <check>',
        'Status-check context to require (the guardian workflow job).',
      ).default('guardian'),
    )
    .addOption(
      new Option('--token <token>', 'Admin token for --apply.').env(
        'GITHUB_TOKEN',
      ),
    )
    .option('--force', 'Skip the check-context-exists verification (risky).')
    .action(async (opts: HardenGateOptions) => {
      await hardenGateCmd(opts, deps);
    });

  program
    .command('pr-check')
    .description('Tier 0 deterministic PR guardian: scope, resolve, gate.')
    .option(
      '--diff <diff>',
      "Diff file, '-' for stdin, or omit to auto-resolve: the PR diff " +
        '(`<base>...HEAD`) in CI, else the local working-tree `git diff`.',
    )
    .option('--coverage <path>', 'Coverage report path (lcov/json).')
    .addOption(
      new Option('--format <fmt>', 'comment|json|text').default('comment'),
    )
    .addOption(new Option('--config <path>').default('harness.config.json'))
    .option('--gate <gate>', 'Override config gate: soft|hard')
    .option(
      '--post-comment',
      'Post/update the sticky PR comment via the GitHub API (CI).',
    )
    .option(
      '--emit-analysis',
      'Write the finding record to the .harness/analyses/ channel ' +
        '(harness handoff, #899); falls back LOUDLY to the sticky comment ' +
        'when the channel is unavailable.',
    )
    .addOption(
      new Option(
        '--analyses-dir <dir>',
        'Override the analyses dir (tests).',
      ).hideHelp(),
    )
    .action(async (opts: PrCheckOptions) => {
      await prCheckCmd(opts, deps);
    });

  program
    .command('author-plan')
    .description('Emit the at-desk authoring plan (intents + block decision).')
    .option(
      '--diff <diff>',
      "Diff file, '-' for stdin, or omit to use `git diff`.",
    )
    .option('--coverage <path>', 'Coverage report path (lcov/json).')
    .addOption(new Option('--config <path>').default('harness.config.json'))
    .option('--json')
    .action((opts: AuthorPlanOptions) => {
      authorPlanCmd(opts, deps);
    });

  program
    .command('mark-authored')
    .description('Write the guardian loop-guard sentinel with authored paths.')
    .option(
      '--path <path>',
      'An authored test path (repeatable). Recorded one per line.',
      collect,
      [] as string[],
    )
    .action((opts: MarkAuthoredOptions) => {
      markAuthoredCmd(opts, deps);
    });

  program
    .command('watch')
    .description(
      'Poll for new merges and analyze each (local dev / CI fallback).',
    )
    .addOption(
      new Option('--interval <secs>', 'Polling interval in seconds.')
        .default(300)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    // Python's `watch` declares `--suite` with NO `-s` short form (unlike
    // `analyze`); adding `-s` here would accept an invocation the oracle rejects.
    .addOption(new Option('--suite <suite>').default('api'))
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .action(async (opts: WatchOptions) => {
      await watchCmd(opts, deps);
    });

  // Propagate the exit-override to every subcommand so their usage errors throw
  // rather than exit the process (mirrors the root override for the CLI wave).
  for (const sub of program.commands) {
    sub.exitOverride(normalizeUsageExit);
  }

  return program;
}

/**
 * The production `guardian` command, wired to process-backed defaults. A future
 * root CLI mounts it via `rootProgram.addCommand(guardianCommand)`.
 */
export const guardianCommand: Command = createGuardianCommand();
