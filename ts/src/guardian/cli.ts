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
 *   - Business exit codes are carried by throwing {@link CliExitError}
 *     (Python's `typer.Exit(n)`); a test's `parseAsync` catches it to read it.
 *     `.exitOverride()` turns commander's own usage errors into throws too, so a
 *     test never terminates the process.
 *
 * Command surface (kebab-case names; the first seven match the shipping Typer
 * CLI, the last two are TS-native additions for #490):
 *   analyze | validate-coverage | harden-gate | pr-check | author-plan |
 *   mark-authored | watch | collect-adjudications | precision.
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
import {
  ReactionsClient,
  RestReactionsClient,
  collectAdjudications,
  loadAdjudicationRecords,
  renderPrecision,
  summarizePrecision,
} from './adjudication.js';
import { emitAnalysis } from './analysis-emit.js';
import { gateOutcome, GateOutcome, SkipEntry } from '../core/gate-result.js';
import {
  ChangedUnit,
  coverageDegradedNotice,
  resolveCoverage,
  resolveCoverageWithInput,
  validateCoverageJson,
} from './coverage.js';
import { buildApiDelta, writeApiDelta } from './delta-emitter.js';
import { extractApiDiff } from './diff-extractor.js';
import {
  BranchProtection,
  HardGateAbstained,
  HardGateBlocked,
  RestBranchProtectionClient,
  applyHardGate,
  renderPlaybook,
} from './hard-gate.js';
import { CoverageRow, mapImpact } from './impact-mapper.js';
import {
  GuardianFinding,
  GateMeta,
  GuardianConfig,
  applySuppressions,
  buildFindings,
  buildWeakTestFindings,
  computeExitCode,
  effectiveGraphDepth,
  filterHeuristicNoise,
  filterSkipped,
  filterTestSupportUnits,
  filterTestUnits,
  filterTypeOnlyUnits,
  findReexportOnly,
  loadGuardianConfig,
  renderFindings,
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
export class CliExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'CliExitError';
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
export class WatchInterruptError extends Error {
  constructor() {
    super('watch interrupted');
    this.name = 'WatchInterruptError';
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
  buildReactionsClient(repo: string, prNumber: number): ReactionsClient;
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
    buildReactionsClient: (repo, prNumber) =>
      new RestReactionsClient(
        repo,
        prNumber,
        process.env['GITHUB_TOKEN'] ?? '',
      ),
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
 * The `https://github.com/<owner>/<repo>/blob/<sha>` prefix for comment
 * permalinks, or `null` when it cannot be resolved.
 *
 * Prefers `pull_request.head.sha` from the event payload over `GITHUB_SHA`: on
 * a `pull_request` event `GITHUB_SHA` is the ephemeral merge commit, and a blob
 * URL against it can 404 once the ref is gone. The head SHA is a real commit on
 * the contributor's branch and stays resolvable.
 *
 * Returns `null` rather than a partial URL whenever repo or SHA is missing, so
 * {@link renderFindings} falls back to plain code text. That degradation is
 * deliberate: an unresolvable link still *looks* clickable, which is worse than
 * no link.
 */
export function blobBaseFromEnv(env: NodeJS.ProcessEnv): string | null {
  const repo = env['GITHUB_REPOSITORY'];
  if (!repo || !repo.includes('/')) return null;
  const sha = headShaFromEvent(env['GITHUB_EVENT_PATH']) ?? env['GITHUB_SHA'];
  if (!sha) return null;

  return `https://github.com/${repo}/blob/${sha}`;
}

/** The one field of a `pull_request` event payload the permalink base reads. */
interface PullRequestEventPayload {
  pull_request?: { head?: { sha?: unknown } };
}

/**
 * `pull_request.head.sha` from the event payload at `eventPath`, or `null`.
 *
 * Every failure — no path, unreadable file, non-JSON body, a payload without a
 * `pull_request` — returns `null` so {@link blobBaseFromEnv} falls through to
 * `GITHUB_SHA` rather than dropping links entirely: a merge-commit link still
 * beats no link.
 */
function headShaFromEvent(eventPath: string | undefined): string | null {
  if (!eventPath) return null;
  try {
    // Optional chaining carries the shape check: on a payload that is not an
    // object (a bare number or string), `?.` short-circuits to `undefined`
    // exactly as an explicit `typeof === 'object'` guard would.
    const event = JSON.parse(
      readFileSync(eventPath, 'utf-8'),
    ) as PullRequestEventPayload | null;
    const head = event?.pull_request?.head?.sha;
    if (typeof head !== 'string') return null;
    return head || null;
  } catch {
    return null;
  }
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

// The sentinel's FIRST line stamps the HEAD the guardian authored at:
// `HEAD <sha>`. Every line after it is one authored path. Anchored at the start
// of the body and hex-only, with a trailing `[ \t\r]*` so a CRLF-written file
// still parses -- anything else reads as malformed, which fails OPEN.
const SENTINEL_HEAD_RE = /^HEAD ([0-9a-fA-F]{7,64})[ \t\r]*(?:\n|$)/;

/**
 * Parse the `HEAD <sha>` stamp off a sentinel body; `null` when malformed.
 *
 * Malformed covers empty, headerless (the pre-#456 paths-only format), and any
 * unparseable first line. Callers MUST treat `null` as "cannot verify" and fail
 * OPEN -- an unreadable sentinel must never wedge authoring off (#456).
 */
function sentinelHeadStamp(text: string): string | null {
  const match = SENTINEL_HEAD_RE.exec(text);
  return match === null ? null : match[1]!.toLowerCase();
}

/** Current `HEAD` sha for `root`, or `null` when git/HEAD is unavailable. */
function headSha(deps: GuardianDeps, root: string): string | null {
  const res = deps.runGit(['rev-parse', 'HEAD'], root);
  if (res === null || res.code !== 0) return null; // no git / no commits
  return res.stdout.trim().toLowerCase() || null;
}

/**
 * Is the loop guard live -- i.e. does a sentinel stamped at the CURRENT `HEAD`
 * exist?
 *
 * This is the surviving half of the stage-and-block-once contract (#456). The
 * component that CLEARED the sentinel on the next commit
 * (`hooks/guardian_precommit.py`) was deleted as dead code in #449, which left
 * `author-plan` fail-closed forever: author once in a clone and Tier-2 authoring
 * never ran again. Stamping HEAD makes the guard self-expiring -- once the human
 * reviews and commits the staged tests, `HEAD` moves, the stamp stops matching,
 * and authoring re-enables itself with no manual step and no hook.
 *
 * Every unverifiable state FAILS OPEN (returns `false`, authoring allowed):
 * missing or unreadable sentinel, a malformed/absent `HEAD` header, or a `HEAD`
 * we cannot resolve. Fail-closed here is exactly the bug being fixed.
 */
function authoredSentinelActive(deps: GuardianDeps, root: string): boolean {
  let body: string;
  try {
    body = readFileSync(authoredSentinelPath(deps, root), 'utf-8');
  } catch {
    return false; // absent or unreadable -> fail open
  }
  const stamp = sentinelHeadStamp(body);
  if (stamp === null) return false; // malformed -> fail open
  const head = headSha(deps, root);
  if (head === null) return false; // unverifiable -> fail open
  return head === stamp;
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

/** Shape of the slice of the Actions event payload we read. */
interface PullRequestEvent {
  pull_request?: { base?: { sha?: unknown } };
}

/**
 * Read `pull_request.base.sha` from the Actions event payload, if present.
 *
 * Optional chaining over a narrow interface (rather than an `unknown` +
 * `typeof` ladder) keeps this at one branch per real failure mode: unreadable
 * file, unparseable JSON, or a payload without a usable sha.
 */
function eventBaseSha(env: NodeJS.ProcessEnv): string | null {
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (!eventPath) return null;
  let sha: unknown;
  try {
    const event = JSON.parse(
      readFileSync(eventPath, 'utf-8'),
    ) as PullRequestEvent | null;
    sha = event?.pull_request?.base?.sha;
  } catch {
    return null;
  }
  return typeof sha === 'string' && sha.trim() ? sha.trim() : null;
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
    throw new CliExitError(2);
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

  // #508 advisory abstention (D3): a diff with zero endpoints analyzed
  // nothing. gateOutcome is the only decision point -- no local === 0.
  const endpointCount =
    diff.added.length + diff.removed.length + diff.changed.length;
  const outcome = gateOutcome(
    { checked: endpointCount, findings: gaps },
    'advisory',
    { noun: 'endpoint(s)' },
  );
  if (outcome.abstained) {
    deps.out(outcome.summaryLine);
    deps.out(
      'guardian: the spec diff contains zero endpoints, so there was no ' +
        'impact to analyze. Pass --spec-before/--spec-after pointing at ' +
        'specs that actually differ.',
    );
  }

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
            checked: endpointCount,
            abstained: outcome.abstained,
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

/** The validator's denominator: entries in the `files` map (#508). */
function coverageEntryCount(data: unknown): number {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 0;
  }
  const files = (data as Record<string, unknown>)['files'];
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return 0;
  }
  return Object.keys(files).length;
}

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
      throw new CliExitError(2);
    }
    text = readFileSync(path, 'utf-8');
  } catch (exc) {
    if (exc instanceof CliExitError) throw exc;
    const msg = exc instanceof Error ? exc.message : String(exc);
    deps.out(`${pc.red(pc.bold(`${CROSS} cannot read ${path}:`))} ${msg}`);
    throw new CliExitError(2);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    deps.out(
      `${pc.red(pc.bold(`${CROSS} ${path} is not valid JSON:`))} ${msg}`,
    );
    throw new CliExitError(2);
  }

  const problems = validateCoverageJson(data);
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const valid = errors.length === 0;
  const outcome = gateOutcome(
    { checked: coverageEntryCount(data), findings: problems },
    'advisory',
    { noun: 'file entrie(s)' },
  );

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
            checked: coverageEntryCount(data),
            abstained: outcome.abstained,
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
      if (outcome.abstained) {
        deps.out(outcome.summaryLine);
        deps.out(
          `guardian: ${path} carries zero file entries ${EM_DASH} nothing ` +
            'was validated. Check that the producer wrote a non-empty ' +
            "'files' map.",
        );
      } else {
        deps.out(
          pc.green(
            pc.bold(`${CHECK} ${path} is a valid coverage-json document.`),
          ),
        );
      }
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
    throw new CliExitError(1);
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
  analysesDir?: string;
}

/**
 * Print the precision evidence the promotion contract depends on (#490).
 *
 * The soft→hard promotion is earned by reviewer adjudication feeding
 * `precision = TP / (TP + FP)`; before #490 that contract lived only in a
 * comment with nothing feeding it. This surfaces the measured number — or an
 * honest `unknown` over an empty sample — in the readiness output. Advisory:
 * it informs the operator's decision, it does not block the registration.
 */
function reportPrecisionEvidence(
  analysesDir: string,
  deps: GuardianDeps,
): void {
  const summary = summarizePrecision(loadAdjudicationRecords(analysesDir));
  const line = renderPrecision(summary);
  deps.out(summary.precision === null ? pc.yellow(line) : line);
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
    throw new CliExitError(2);
  }

  const playbook = renderPlaybook(repo, opts.branch, opts.check);

  // #490: the readiness evidence the promotion is supposed to rest on.
  reportPrecisionEvidence(resolveAnalysesDir(opts.analysesDir, deps), deps);

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
    throw new CliExitError(2);
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
    if (exc instanceof HardGateAbstained) {
      const outcome = gateOutcome({ checked: 0, findings: [] }, 'gate', {
        noun: 'check context(s)',
      });
      deps.out(outcome.summaryLine);
      deps.out(`${pc.red(pc.bold(`${CROSS} ${exc.reason}`))}\n`);
      deps.out(exc.playbook);
      throw new CliExitError(outcome.exitCode); // 3, never 1
    }
    if (exc instanceof HardGateBlocked) {
      deps.out(`${pc.red(pc.bold(`${CROSS} ${exc.reason}`))}\n`);
      deps.out(exc.playbook);
      throw new CliExitError(1);
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

// --- collect-adjudications / precision (#490) ----------------------------------

interface CollectAdjudicationsOptions {
  repo?: string;
  pr?: number;
  analysesDir?: string;
  json?: boolean;
}

/**
 * Explicit adjudication sweep for one PR (the scheduled-sweep / at-desk shape;
 * `pr-check` runs the same collection inline on its CI surfaces). Unlike the
 * inline best-effort path this one FAILS LOUDLY (exit 1 on an unavailable
 * channel) — an operator who asked for a collection must know it did not land.
 */
async function collectAdjudicationsCmd(
  opts: CollectAdjudicationsOptions,
  deps: GuardianDeps,
): Promise<void> {
  let repo = opts.repo;
  let prNumber = opts.pr;
  if (!repo || prNumber === undefined) {
    const ctx = prContextFromEnv(deps.env);
    if (ctx !== null) {
      repo = repo ?? ctx[0];
      prNumber = prNumber ?? ctx[1];
    }
  }
  if (!repo || prNumber === undefined) {
    deps.out(
      `${pc.red(pc.bold(`${CROSS} no PR context`))} ${EM_DASH} pass --repo and --pr, or run in Actions.`,
    );
    throw new CliExitError(2);
  }

  const client = deps.buildReactionsClient(repo, prNumber);
  const res = await collectAdjudications(client, {
    repo,
    prNumber,
    analysesDir: resolveAnalysesDir(opts.analysesDir, deps),
  });

  if (opts.json) {
    deps.out(
      ensureAscii(
        JSON.stringify(
          { action: res.action, path: res.path, record: res.record },
          null,
          2,
        ),
      ),
    );
  } else if (res.action === 'collected' && res.record) {
    deps.out(
      pc.green(
        `${CHECK} adjudication recorded (${res.record.tp} up / ` +
          `${res.record.fp} down, ${res.record.granularity}-level) ` +
          `${RIGHT_ARROW} ${res.path}`,
      ),
    );
  } else if (res.action === 'no-comment') {
    deps.out(
      `guardian: no sticky comment on ${repo}#${prNumber} ${EM_DASH} nothing to adjudicate.`,
    );
  } else if (res.action === 'no-reactions') {
    deps.out(
      `guardian: sticky comment on ${repo}#${prNumber} has no reviewer ` +
        `verdicts yet ${EM_DASH} nothing recorded (no reaction is neutral, ` +
        `not a data point).`,
    );
  }

  if (res.action === 'unavailable') {
    deps.out(pc.red(pc.bold(`${CROSS} ${res.notice ?? 'not persisted'}`)));
    throw new CliExitError(1);
  }
}

interface PrecisionOptions {
  analysesDir?: string;
  json?: boolean;
}

/** Aggregate the persisted adjudications into the promotion evidence (#490). */
function precisionCmd(opts: PrecisionOptions, deps: GuardianDeps): void {
  const analysesDir = resolveAnalysesDir(opts.analysesDir, deps);
  const records = loadAdjudicationRecords(analysesDir);
  const summary = summarizePrecision(records);
  if (opts.json) {
    // `precision: null` is the honest zero-denominator value — consumers must
    // treat it as unknown, never as 1.0 (#490).
    deps.out(
      ensureAscii(
        JSON.stringify({ ...summary, records: records.length }, null, 2),
      ),
    );
    return;
  }
  const line = renderPrecision(summary);
  deps.out(summary.precision === null ? pc.yellow(line) : line);
}

// --- pr-check -----------------------------------------------------------------

/**
 * Upsert the Phase-2 sticky PR comment (behavior-preserving extraction). When no
 * PR context is resolvable from env, prints the body instead of crashing; a
 * read-only-token degradation is surfaced LOUDLY.
 */
async function postStickyComment(
  findings: GuardianFinding[],
  resolution: TierResolution,
  deps: GuardianDeps,
  gateMeta: GateMeta | null = null,
): Promise<void> {
  const body = renderFindings(
    findings,
    'comment',
    resolution.effective,
    resolution.degraded_notice,
    gateMeta,
    blobBaseFromEnv(deps.env),
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

/** The gate's no-op line, shared by the pre- and post-filter exits. */
// D7: every filtered path stays visible as a SkipEntry, never folded
// into "passed". One entry per path so the rendered count still equals
// the path count the old `N path(s) skipped` line reported.
function prCheckSkipEntries(
  skipped: ChangedUnit[],
  testUnits: ChangedUnit[],
  barrelUnits: ChangedUnit[],
  supportUnits: ChangedUnit[] = [],
  typeOnlyUnits: ChangedUnit[] = [],
): SkipEntry[] {
  return [
    ...skipped.map((u) => ({ name: u.path, reason: 'skipGlobs' })),
    ...testUnits.map((u) => ({ name: u.path, reason: 'test path' })),
    // #565: distinct from 'test path' on purpose -- these are test
    // infrastructure recognised by filename idiom, and adjudication needs to
    // tell the two suppression causes apart.
    ...supportUnits.map((u) => ({ name: u.path, reason: 'test support' })),
    // #562: likewise distinct -- adjudication has to be able to measure this
    // class separately, since it is the one that held precision at 13/20.
    ...typeOnlyUnits.map((u) => ({ name: u.path, reason: 'type-only module' })),
    ...barrelUnits.map((u) => ({
      name: u.path,
      reason: 're-export barrel',
    })),
  ];
}

/**
 * The heuristic-noise skip class (#413), which is only knowable AFTER the
 * coverage ladder has scored each unit — so it cannot join
 * {@link prCheckSkipEntries}, which must be built before the abstain exit.
 * Kept a named function so the reason token has exactly one definition.
 */
function heuristicSkipEntries(noisePaths: string[]): SkipEntry[] {
  return noisePaths.map((p) => ({ name: p, reason: 'heuristic-ineligible' }));
}

// Remediation is required copy (#508): say WHY the denominator
// collapsed and the first fix step. The #456 class, now loud.
const PR_CHECK_ABSTAIN_REMEDIATION = [
  'guardian: the diff contained no findings-eligible units, so NO ' +
    'coverage was verified. This is not a pass (exit 3, abstained).',
  'If you expected verification: in CI, checkout with fetch-depth: 0 ' +
    'or pass --diff <base>...HEAD; locally, confirm the diff is ' +
    'non-empty and skipGlobs/heuristicExclude are not filtering ' +
    'every path.',
];

/** Exit 3 with the structural abstention line + remediation (#508). */
function abstainPrCheck(
  skipped: SkipEntry[],
  format: string,
  deps: GuardianDeps,
): never {
  const outcome = gateOutcome({ checked: 0, findings: [], skipped }, 'gate', {
    noun: 'unit(s)',
  });
  deps.out(outcome.summaryLine);
  for (const line of PR_CHECK_ABSTAIN_REMEDIATION) deps.out(line);
  if (format === 'json') {
    deps.out(
      ensureAscii(
        JSON.stringify(
          // #579: `skipped` carries the denominator the abstention collapsed
          // to. Without it a consumer sees `abstained: true` and cannot tell
          // WHAT was dropped or why -- the #508 class one layer down, on the
          // only surface a machine can read.
          { findings: [], tier: 0, checked: 0, abstained: true, skipped },
          null,
          2,
        ),
      ),
    );
  }
  throw new CliExitError(outcome.exitCode); // EXIT_ABSTAINED
}

/** Resolve the analyses-channel dir (test override, else repo-root default). */
function resolveAnalysesDir(
  override: string | undefined,
  deps: GuardianDeps,
): string {
  return override ?? join(gitToplevel(deps), '.harness', 'analyses');
}

/**
 * Collect 👍/👎 adjudications off the sticky comment, best-effort (#490).
 *
 * Runs on the NEXT `pr-check` for a PR (the collection loop the #490 sketch
 * chose over a scheduled sweep — the guardian already authenticates against
 * this API and already finds its own comment by marker). Read-only against
 * GitHub, so it works where the fork-degraded poster could not write.
 *
 * NEVER affects the gate: any failure prints a `::warning::` and returns —
 * a broken feedback loop must not turn a coverage gate red.
 */
async function collectAdjudicationsBestEffort(
  analysesDirOverride: string | undefined,
  deps: GuardianDeps,
): Promise<void> {
  const ctx = prContextFromEnv(deps.env);
  if (ctx === null) return; // no PR context — nothing to collect against
  if (!deps.env['GITHUB_TOKEN']) {
    // Every read here needs a token; skipping LOUDLY beats a guaranteed 401.
    deps.out(
      degradationAnnotation(
        `guardian: no GITHUB_TOKEN ${EM_DASH} reviewer adjudications not ` +
          'collected this run',
      ),
    );
    return;
  }
  // Resolved lazily (shells out to git) only once a collection will happen —
  // an explicit `--diff` run without PR context must stay subprocess-free.
  const analysesDir = resolveAnalysesDir(analysesDirOverride, deps);
  try {
    const client = deps.buildReactionsClient(ctx[0], ctx[1]);
    const res = await collectAdjudications(client, {
      repo: ctx[0],
      prNumber: ctx[1],
      analysesDir,
    });
    if (res.action === 'collected' && res.record) {
      deps.out(
        `guardian: adjudication recorded (${res.record.tp} up / ` +
          `${res.record.fp} down) ${RIGHT_ARROW} ${res.path}`,
      );
    } else if (res.action === 'unavailable' && res.notice) {
      deps.out(degradationAnnotation(res.notice));
    }
    // no-comment / no-reactions: nothing to say — absence of a reaction is
    // neutral, not a data point (#490).
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    deps.out(
      degradationAnnotation(
        `guardian: adjudication collection failed (${message}) ${EM_DASH} ` +
          'findings and gate unaffected',
      ),
    );
  }
}

interface PrCheckOptions {
  diff?: string;
  heuristicExclude?: string[];
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
    throw new CliExitError(0);
  }

  const effectiveGate = opts.gate ?? config.pr_gate;

  // #490: read reviewer 👍/👎 off the PREVIOUS run's sticky comment before this
  // run touches it. Runs on the posting/emitting (CI) surfaces only, before the
  // early exits so a docs-only follow-up push still harvests the verdicts.
  if (opts.postComment || opts.emitAnalysis) {
    await collectAdjudicationsBestEffort(opts.analysesDir, deps);
  }

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
  // #565: drop test *support* units -- a conftest / fixture module is the
  // harness the tests run inside, so no test can cover it at any tier.
  const [keptSupport, supportUnits] = filterTestSupportUnits(keptTest);
  // #562: drop modules with no runtime content -- an interface cannot be
  // executed, so its uncovered lines are a finding no test could ever satisfy.
  // `.` (cwd), matching the repoRoot convention `resolveCoverageWithInput`
  // already uses for the heuristic tier's own file reads.
  const [keptTyped, typeOnlyUnits] = filterTypeOnlyUnits(keptSupport, '.');
  // FIX 2: drop pure re-export/barrel files.
  const reexportPaths = findReexportOnly(diffText);
  const barrelUnits = keptTyped.filter((u) => reexportPaths.has(u.path));
  const kept = keptTyped.filter((u) => !reexportPaths.has(u.path));

  // Advisory weak-test findings for added tests that assert nothing.
  const weakFindings = config.weak_tests
    ? buildWeakTestFindings(testUnits, diffText)
    : [];

  // #582: build the skip list ONCE, above the abstain exit, so the surviving
  // (non-abstain) path carries the same denominator the abstain payload has
  // carried since #579. The heuristic-noise class is not known until the
  // coverage ladder has run, so it is appended below rather than passed here.
  //
  // This supersedes a `preFilterSkipped` count that was computed at this point
  // and read by nothing — the fossil of an earlier attempt to surface the same
  // number on this path.
  const preCoverageSkips = prCheckSkipEntries(
    skipped,
    testUnits,
    barrelUnits,
    supportUnits,
    typeOnlyUnits,
  );

  if (kept.length === 0 && weakFindings.length === 0) {
    abstainPrCheck(preCoverageSkips, opts.format, deps);
  }

  const { results, coverage } = resolveCoverageWithInput(kept, {
    coveragePath: opts.coverage ?? null,
    // #320: under a hard gate the graph tier requires a DIRECT test->source edge
    // (depth 1); soft stays unbounded. An explicit config value wins.
    graphMaxDepth: effectiveGraphDepth(config, effectiveGate),
  });
  // #413: drop uncovered HEURISTIC verdicts on paths a naming heuristic can
  // never judge (non-source, or an excluded glob). Coverage/graph-verified
  // verdicts on the same paths are real evidence and survive.
  const [scoredResults, noiseResults] = filterHeuristicNoise(
    results,
    opts.heuristicExclude ?? config.heuristic_exclude,
  );
  const findings = [
    ...applySuppressions(buildFindings(scoredResults)),
    ...weakFindings,
  ];

  // The complete skip list for this run: the pre-coverage filters plus the
  // heuristic-noise class the ladder just revealed.
  const allSkips: SkipEntry[] = [
    ...preCoverageSkips,
    ...heuristicSkipEntries(noiseResults.map((r) => r.unit.path)),
  ];

  // #413: if the heuristic filter consumed every scorable unit, report it as a
  // SKIP rather than rendering an empty "0 unaddressed" report -- an adopter
  // must be able to tell "nothing was judgeable" from "everything passed".
  if (scoredResults.length === 0 && findings.length === 0) {
    abstainPrCheck(allSkips, opts.format, deps);
  }

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

  // #554: every surface below carries the coverage-input state, so a run that
  // never saw a coverage report cannot present as one that checked and passed.
  const gateMeta: GateMeta = {
    checked: scoredResults.length,
    abstained: false,
    coverage,
    // #582: `checked` is the numerator of a fraction whose denominator was
    // never printed. This is the rest of it.
    skipped: allSkips,
  };
  const coverageNotice = coverageDegradedNotice(coverage);
  if (coverageNotice) {
    // `--format json` owns stdout: a `::warning::` line there would make the
    // document unparseable, so the annotation goes to stderr on that path. Both
    // streams are scanned for workflow commands, so CI still sees it.
    const machineStdout =
      !opts.postComment && !opts.emitAnalysis && opts.format === 'json';
    (machineStdout ? deps.err : deps.out)(
      degradationAnnotation(coverageNotice),
    );
    appendStepSummary(deps.env, coverageNotice);
  }

  let commentPosted = false;
  if (opts.emitAnalysis) {
    // SC-10 producer half: write ONE record to the analyses channel. On an
    // unavailable channel `emitAnalysis` returns a LOUD notice and we fall back
    // to the sticky comment -- the record is never silently dropped.
    const analysesDir = resolveAnalysesDir(opts.analysesDir, deps);
    const res = emitAnalysis(findings, {
      analysesDir,
      ref: resolveAnalysisRef(deps),
      gate: effectiveGate,
      effective_tier: resolution.effective,
      degraded_notice: resolution.degraded_notice,
      exit_code: exitCode,
      checked: scoredResults.length,
      abstained: false, // an abstained run exits before emit (see plan)
      coverage,
      skipped: allSkips,
    });
    if (res.action === 'emitted') {
      deps.out(`guardian: wrote analysis record ${RIGHT_ARROW} ${res.path}`);
    } else {
      // LOUD fallback: `::warning::` + step-summary + stderr, then the Phase-2
      // sticky comment so findings stay visible (SC-10 fallback).
      deps.out(degradationAnnotation(res.notice!));
      appendStepSummary(deps.env, res.notice!);
      deps.err(res.notice!);
      await postStickyComment(findings, resolution, deps, gateMeta);
      commentPosted = true;
    }
  }

  if (opts.postComment && !commentPosted) {
    // Explicit `--post-comment`: post/upsert unless the SC-10 fallback already
    // posted this run.
    await postStickyComment(findings, resolution, deps, gateMeta);
  } else if (!opts.emitAnalysis && !opts.postComment) {
    // Local, non-posting default: render to stdout in `--format`.
    deps.out(
      renderFindings(
        findings,
        opts.format,
        resolution.effective,
        resolution.degraded_notice,
        gateMeta,
        blobBaseFromEnv(deps.env),
      ),
    );
  }

  throw new CliExitError(exitCode);
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
): GuardianFinding[] {
  const units = scopeDiff(diffText);
  const [keptSkip] = filterSkipped(units, config.skip_globs);
  const [keptTest] = filterTestUnits(keptSkip);
  // #565: never hand the authoring tier a conftest/fixture module either -- a
  // generated "test for the fixture" is exactly the inversion the gate exists
  // to prevent, except it also writes a file (measured: this surface proposed
  // `scripts/otel_bootstrap/test_conftest_otel.py`).
  const [keptSupport] = filterTestSupportUnits(keptTest);
  // #562: nor a type-only module -- measured, this surface proposed writing
  // `src/ConfirmModal/types.test.ts` to test an interface, a file whose only
  // possible content is an assertion about nothing.
  const [keptTyped] = filterTypeOnlyUnits(keptSupport, '.');
  const reexportPaths = findReexportOnly(diffText);
  const kept = keptTyped.filter((u) => !reexportPaths.has(u.path));
  if (kept.length === 0) return [];
  const results = resolveCoverage(kept, { coveragePath, graphMaxDepth });
  // #413: never hand the authoring tier a heuristic FP -- a generated "test" for
  // a config dotfile is worse noise than the finding was.
  const [scored] = filterHeuristicNoise(results, config.heuristic_exclude);
  return applySuppressions(buildFindings(scored));
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

/**
 * author-plan's denominator decision (#508, review-round gap).
 *
 * The spec's audit list named `author-plan` next to `pr-check`, but #515
 * deferred it ("guardian internals being reworked in parallel") and Wave 2 only
 * took pr-check. On an EMPTY diff this surface emitted
 * `block: false, authored_count: 0` and exited 0 -- "we examined nothing,
 * therefore do not block", which is the #456 class verbatim.
 *
 * ADVISORY, not a gate: author-plan is an authoring aid whose JSON an agent
 * reads (see `canary-pr-guardian/SKILL.md`); the exit-code contract belongs to
 * `pr-check` and the pre-commit gate. So the exit stays 0 and stdout stays a
 * single parseable object -- `checked`/`abstained` ride the payload additively
 * and the loud line goes to stderr, keeping `--json` consumers byte-compatible.
 */
function authorPlanOutcome(
  checked: number,
  results: readonly unknown[],
  deps: GuardianDeps,
): GateOutcome {
  const outcome = gateOutcome({ checked, findings: [...results] }, 'advisory', {
    noun: 'gap(s)',
  });
  if (outcome.abstained) {
    deps.err(
      `${outcome.summaryLine} guardian author-plan scoped zero coverage ` +
        'gaps, so "nothing to author" here means nothing was EXAMINED, not ' +
        'that everything is covered. Confirm the diff is non-empty and that ' +
        'skipGlobs is not filtering every path.',
    );
  }
  return outcome;
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
    // #456: HEAD-stamped, so the guard expires on the next commit by itself.
    authored_sentinel_present: authoredSentinelActive(deps, repoRoot),
  });
  const results = deps.makeAgentTier().author_tests(gaps, ctx);
  const decision = decideBlock(results);

  const outcome = authorPlanOutcome(gaps.length, results, deps);

  const payload = {
    intents: results.map(intentDict),
    block: {
      block: decision.block,
      message: decision.message,
      authored_count: decision.authored_count,
    },
    checked: gaps.length,
    abstained: outcome.abstained,
  };
  deps.out(ensureAscii(JSON.stringify(payload, null, 2)));
}

// --- mark-authored ------------------------------------------------------------

interface MarkAuthoredOptions {
  path: string[];
}

/**
 * Record the authored paths in the loop-guard sentinel, stamped with the HEAD
 * they were authored at (#456).
 *
 * The `HEAD <sha>` header is what makes the guard self-expiring: `author-plan`
 * honors it only while `HEAD` still matches, so the human's review commit clears
 * it implicitly. When `HEAD` cannot be resolved (a repo with no commits, or no
 * git at all) the header is omitted -- an unstamped sentinel reads as malformed
 * and FAILS OPEN, which is the safe direction.
 */
function markAuthoredCmd(opts: MarkAuthoredOptions, deps: GuardianDeps): void {
  const root = gitToplevel(deps);
  const sentinel = authoredSentinelPath(deps, root);
  mkdirSync(dirname(sentinel), { recursive: true });
  const head = headSha(deps, root);
  const header = head === null ? '' : `HEAD ${head}\n`;
  const body = header + opts.path.map((p) => `${p}\n`).join('');
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
    if (exc instanceof WatchInterruptError) {
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
 * code from the thrown error (or from {@link CliExitError} for business exits).
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
    .addOption(
      new Option(
        '--analyses-dir <dir>',
        'Override the analyses dir (tests).',
      ).hideHelp(),
    )
    .action(async (opts: HardenGateOptions) => {
      await hardenGateCmd(opts, deps);
    });

  program
    .command('collect-adjudications')
    .description(
      "Read reviewer thumbs-up/down reactions off the guardian's sticky PR " +
        'comment and persist the adjudication record (#490).',
    )
    .addOption(
      new Option('--repo <repo>', 'owner/repo.').env('GITHUB_REPOSITORY'),
    )
    .addOption(
      new Option('--pr <number>', 'Pull-request number.').argParser((v) =>
        Number.parseInt(v, 10),
      ),
    )
    .option('--json', 'Emit the collection result as JSON.')
    .addOption(
      new Option(
        '--analyses-dir <dir>',
        'Override the analyses dir (tests).',
      ).hideHelp(),
    )
    .action(async (opts: CollectAdjudicationsOptions) => {
      await collectAdjudicationsCmd(opts, deps);
    });

  program
    .command('precision')
    .description(
      'Report guardian finding precision (TP / (TP + FP)) from collected ' +
        'adjudications, with its sample size.',
    )
    .option('--json', 'Emit the summary as JSON (precision null = unknown).')
    .addOption(
      new Option(
        '--analyses-dir <dir>',
        'Override the analyses dir (tests).',
      ).hideHelp(),
    )
    .action((opts: PrecisionOptions) => {
      precisionCmd(opts, deps);
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
      '--heuristic-exclude <glob>',
      'Glob whose paths never produce a heuristic-tier finding (repeatable). ' +
        'Replaces canary.guardian.pr.heuristicExclude for this run. ' +
        'Coverage/graph-verified findings are unaffected.',
      (value: string, previous?: string[]) => [...(previous ?? []), value],
    )
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
