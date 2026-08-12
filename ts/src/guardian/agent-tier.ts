/**
 * Agent-tier capability boundary for canary-pr-guardian (Phase 4).
 *
 * Faithful TypeScript port of `agent/guardian/agent_tier.py`.
 *
 * This is the **one** module where agent orchestration is allowed -- it sits
 * OUTSIDE the Tier-0 deterministic engine (`pr-check.ts`/`coverage.ts`/
 * `tier.ts`), which imports it never (SC-11). Under the chosen **Option A**
 * invocation mechanism it **never calls an LLM directly**: it (i) turns
 * deterministic Tier-0 gaps into structured authoring intents, (ii) parses and
 * validates agent results into `GuardianFinding`/`GeneratedTest` records, and (iii)
 * enforces the write-safety model (opt-in, fork, collision, loop-guard) and the
 * block-once decision. It reaches an agent runtime only through an injected
 * `AgentInvoker` **port**; the production default (`RecordingInvoker`) records
 * an intent and calls nothing, while the `canary-pr-guardian` SKILL fulfils it
 * in-session.
 *
 * Python->TS nuances:
 *   - `pathlib.Path` fields become plain POSIX path strings (`test_paths`,
 *     `repo_root`), matching how the rest of the ts port models paths.
 *   - `dataclasses.replace(...)` becomes constructing a fresh `GeneratedTest`
 *     with a spread override (the invoker test double does this).
 *   - `_target_test_path` reimplements the `pathlib` parent/stem/suffix/as_posix
 *     algebra directly so a bare filename yields no `./` prefix (Python drops
 *     the `.` parent on join).
 */

import { existsSync } from 'node:fs';

import { Severity } from './impact-mapper.js';
import { GuardianFinding } from './pr-check.js';

/** What Tier 1 asks `canary-test-reviewer` to audit (read-only). */
export interface ReviewRequest {
  test_paths: string[];
}

/** Construct a {@link ReviewRequest} (a frozen dataclass in Python). */
function reviewRequest(test_paths: string[]): ReviewRequest {
  return { test_paths };
}

/**
 * An authoring intent and its (eventual) result.
 *
 * v1 `status`: `'planned'` (the {@link RecordingInvoker} default -- the SKILL
 * fulfils it in-session), `'authored'` (a fake/real invoker wrote it), or
 * `'skipped'` (a safety guard blocked it, with `skip_reason`).
 */
export class GeneratedTest {
  gap: GuardianFinding;
  target_path: string;
  requirement: string; // NL requirement -> /canary-write-test $ARGUMENTS
  status: string; // planned | authored | skipped
  written_path: string | null;
  skip_reason: string | null;

  constructor(init: {
    gap: GuardianFinding;
    target_path: string;
    requirement: string;
    status?: string;
    written_path?: string | null;
    skip_reason?: string | null;
  }) {
    this.gap = init.gap;
    this.target_path = init.target_path;
    this.requirement = init.requirement;
    this.status = init.status ?? 'planned';
    this.written_path = init.written_path ?? null;
    this.skip_reason = init.skip_reason ?? null;
  }
}

/** Port to an agent runtime. Production default records; tests fake it. */
export interface AgentInvoker {
  review(request: ReviewRequest): string; // -> transcript
  author(intent: GeneratedTest): GeneratedTest; // -> authored
}

/**
 * Default production invoker: calls NOTHING.
 *
 * Returns an empty transcript and a still-`planned` intent so the SKILL fulfils
 * the work in-session (Option A). This is what keeps the deterministic layer
 * LLM-free.
 */
export class RecordingInvoker implements AgentInvoker {
  review(_request: ReviewRequest): string {
    void _request;
    return ''; // nothing reviewed here; SKILL drives canary-test-reviewer
  }

  author(intent: GeneratedTest): GeneratedTest {
    return intent; // status stays 'planned'; SKILL drives canary-test-author
  }
}

/** The capability boundary a future `CiAgentTier` also implements. */
export interface AgentTier {
  audit_test_quality(affected_tests: string[]): GuardianFinding[];
  author_tests(
    gaps: GuardianFinding[],
    ctx?: AuthoringContext | null,
  ): GeneratedTest[];
}

// A canary-test-reviewer transcript line: `[severity] path:line <message>`.
// The message tail is optional and captured as evidence. Anchored ^...$ with no
// flags -- matched per-line (the transcript is split first), so `$` binds the
// end of each line and `.` never needs to span newlines.
const REVIEW_LINE_RE =
  /^\s*\[(?<severity>[^\]]+)\]\s+(?<path>\S+?):(?<line>\d+)(?:\s+(?<msg>.*))?$/;

// Case-insensitive lookup of a reviewer severity token -> the Tier-0 Severity.
const SEVERITY_BY_NAME = new Map<string, Severity>(
  Object.values(Severity).map((s) => [s, s]),
);

/**
 * Parse `canary-test-reviewer`'s `[severity] path:line` lines into `weak-test`
 * Findings.
 *
 * A malformed line (no `[severity] path:line` shape) or an unknown severity
 * token is skipped, never raised. An empty transcript (the {@link
 * RecordingInvoker} default) yields `[]` -- the SKILL reports its review
 * directly in-session.
 */
function parseReviewFindings(transcript: string): GuardianFinding[] {
  const findings: GuardianFinding[] = [];
  for (const raw of transcript.split(/\r\n|\r|\n/)) {
    const match = REVIEW_LINE_RE.exec(raw);
    if (match === null || match.groups === undefined) continue;
    // `severity` and `path` are required capture groups -- present on any match.
    const severityToken = match.groups['severity']!;
    const severity = SEVERITY_BY_NAME.get(severityToken.trim().toLowerCase());
    if (severity === undefined) continue;
    const path = match.groups['path']!;
    findings.push(
      new GuardianFinding({
        path,
        unit: path,
        kind: 'weak-test',
        severity,
        evidence: (match.groups['msg'] ?? '').trim(),
      }),
    );
  }
  return findings;
}

/**
 * v1 {@link AgentTier}: drives `canary-test-reviewer`/`-author` via an injected
 * invoker. Calls NO LLM itself (Option A) -- the invoker is the port.
 */
export class InSessionAgentTier implements AgentTier {
  invoker: AgentInvoker;

  constructor(init: { invoker?: AgentInvoker } = {}) {
    this.invoker = init.invoker ?? new RecordingInvoker();
  }

  /**
   * Tier 1 (read-only): ask the reviewer to audit `affected_tests` and parse the
   * transcript into `weak-test` Findings. Writes nothing.
   */
  audit_test_quality(affected_tests: string[]): GuardianFinding[] {
    const transcript = this.invoker.review(reviewRequest([...affected_tests]));
    return parseReviewFindings(transcript);
  }

  /**
   * Tier 2: plan the safe authoring intents, then hand each `planned` intent to
   * the injected invoker (the {@link RecordingInvoker} default leaves it
   * `planned` -- Option A; a fake/real invoker returns `authored`). `skipped`
   * records pass through untouched. Absent `ctx` the caller gets the fail-closed
   * default (opt-in off, tier 0 -> everything skipped).
   */
  author_tests(
    gaps: GuardianFinding[],
    ctx: AuthoringContext | null = null,
  ): GeneratedTest[] {
    const plan = planAuthoring(gaps, ctx ?? new AuthoringContext(false, 0));
    const out: GeneratedTest[] = [];
    for (const intent of plan) {
      if (intent.status === 'planned') {
        out.push(this.invoker.author(intent)); // -> authored (fake/real)
      } else {
        out.push(intent); // skipped, unchanged
      }
    }
    return out;
  }
}

/**
 * Reports the agent tier ceiling from an explicit opt-in signal.
 *
 * Reads env `CANARY_GUARDIAN_AGENT` (`0|1|2`), which the SKILL exports when it
 * runs in-session. Unset or invalid -> `0` (so CI, where the env is unset, stays
 * Tier-0). Returns an `int` only -- imports no LLM (SC-11), so it drops into
 * `resolveTier` unchanged as the real `AgentCapabilityProbe`.
 */
export class InSessionAgentProbe {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  availableTier(): number {
    const raw = this.env['CANARY_GUARDIAN_AGENT'] ?? '0';
    return raw === '0' || raw === '1' || raw === '2'
      ? Number.parseInt(raw, 10)
      : 0;
  }
}

// --- Tier-2 authoring safety model (D4 guards a-d) -- pure, writes nothing. ---

// Language-specific test-path templates (peer-layout mirror).
const TS_JS_SUFFIXES = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);

/**
 * Everything `planAuthoring` needs to apply the four safety guards.
 *
 * All fields are supplied by the caller (the `author-plan` CLI seam); this keeps
 * the guards pure and deterministic. `repo_root` is a POSIX path string (the
 * Python `pathlib.Path` field).
 */
export class AuthoringContext {
  author_tests_optin: boolean; // config.precommit_author_tests (default False) -- (d)
  effective_tier: number; // from resolveTier (2 == can author)
  is_fork: boolean; // reuse Phase-2 fork/403 detection -- (b)
  repo_root: string; // collision + sentinel base
  // loop-guard -- (a). True only when a sentinel stamped at the CURRENT HEAD
  // exists (#456): the caller resolves the stamp, and every unverifiable state
  // (missing/unreadable/malformed sentinel, unresolvable HEAD) passes `false`
  // so authoring fails OPEN.
  authored_sentinel_present: boolean;

  constructor(
    author_tests_optin: boolean,
    effective_tier: number,
    init: {
      is_fork?: boolean;
      repo_root?: string;
      authored_sentinel_present?: boolean;
    } = {},
  ) {
    this.author_tests_optin = author_tests_optin;
    this.effective_tier = effective_tier;
    this.is_fork = init.is_fork ?? false;
    this.repo_root = init.repo_root ?? '.';
    this.authored_sentinel_present = init.authored_sentinel_present ?? false;
  }
}

/** POSIX `parent`/`stem`/`suffix` split mirroring `pathlib.PurePosixPath`. */
function posixParts(path: string): {
  parent: string;
  stem: string;
  suffix: string;
} {
  const segments = path.split('/');
  const base = segments.pop() ?? '';
  const parent = segments.join('/');
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    return { parent, stem: base.slice(0, dot), suffix: base.slice(dot) };
  }
  return { parent, stem: base, suffix: '' };
}

/** Join a POSIX parent and child the way `pathlib` `/` + `as_posix()` does. */
function joinPosix(parent: string, child: string): string {
  return parent === '' || parent === '.' ? child : `${parent}/${child}`;
}

/**
 * Deterministic target test path for a gap, mirroring peer test layout.
 *
 * - `.py` source -> `{parent}/test_{stem}.py` (pytest convention);
 * - TS/JS source -> `{parent}/{stem}.test{suffix}` (jest/vitest convention);
 * - anything else -> `{parent}/{stem}.test{suffix}` as a safe default.
 *
 * Returns a repo-relative POSIX path string.
 */
export function targetTestPath(gap: GuardianFinding): string {
  const { parent, stem, suffix } = posixParts(gap.path);
  let targetName: string;
  if (suffix === '.py') {
    targetName = `test_${stem}.py`;
  } else if (TS_JS_SUFFIXES.has(suffix)) {
    targetName = `${stem}.test${suffix}`;
  } else {
    targetName = `${stem}.test${suffix || ''}`;
  }
  return joinPosix(parent, targetName);
}

/**
 * NL requirement string the `/canary-write-test` command consumes as
 * `$ARGUMENTS` -- names the unit and the untested change.
 */
function requirementFor(gap: GuardianFinding): string {
  return (
    `Write tests for \`${gap.unit}\` in \`${gap.path}\` covering the newly ` +
    `added, currently-untested code (guardian finding: ${gap.kind}).`
  );
}

// The skip-reason strings carry an em-dash (U+2014) as load-bearing output data
// (surfaced to the SKILL); written as an escape to honor the ASCII-source rule.
const EM_DASH = '\u{2014}';

/**
 * Return the first failing guard's reason, or `null` if all guards pass.
 *
 * Guard order (fail-closed, cheapest/broadest first): (d) opt-in, (d) tier,
 * (b) fork, (a) loop-guard, (c) collision.
 */
function authoringSkipReason(
  gap: GuardianFinding,
  ctx: AuthoringContext,
): string | null {
  if (!ctx.author_tests_optin) {
    return `opt-in: preCommit.authorTests is not enabled ${EM_DASH} authoring is off by default`;
  }
  if (ctx.effective_tier < 2) {
    return `tier: effective tier ${ctx.effective_tier} < 2 ${EM_DASH} cannot author`;
  }
  if (ctx.is_fork) {
    return `fork: read-only ${EM_DASH} guardian never writes on a fork PR`;
  }
  if (ctx.authored_sentinel_present) {
    return (
      `loop-guard: guardian tests already authored at this HEAD ${EM_DASH} ` +
      `review and commit them to re-enable authoring`
    );
  }
  const target = joinPosix(ctx.repo_root, targetTestPath(gap));
  if (existsSync(target)) {
    return `collision: ${targetTestPath(gap)} exists ${EM_DASH} another PR/session may own it`;
  }
  return null;
}

/**
 * Apply the four D4 guards and emit one {@link GeneratedTest} per gap.
 *
 * A gap that clears every guard becomes a `planned` intent (non-empty
 * `requirement` + `target_path`); any guard failure becomes a `skipped` record
 * carrying the reason. Pure -- reads disk only to detect collisions (guard c)
 * and writes **nothing**.
 */
export function planAuthoring(
  gaps: GuardianFinding[],
  ctx: AuthoringContext,
): GeneratedTest[] {
  const out: GeneratedTest[] = [];
  for (const gap of gaps) {
    const target = targetTestPath(gap);
    const requirement = requirementFor(gap);
    const reason = authoringSkipReason(gap, ctx);
    if (reason === null) {
      out.push(
        new GeneratedTest({
          gap,
          target_path: target,
          requirement,
          status: 'planned',
        }),
      );
    } else {
      out.push(
        new GeneratedTest({
          gap,
          target_path: target,
          requirement,
          status: 'skipped',
          skip_reason: reason,
        }),
      );
    }
  }
  return out;
}

/** The pre-commit block-once decision computed from an authoring run. */
export class BlockDecision {
  block: boolean;
  message: string;
  authored_count: number;

  constructor(block: boolean, message: string, authored_count: number) {
    this.block = block;
    this.message = message;
    this.authored_count = authored_count;
  }
}

// The block message carries a no-entry sign (U+26D4) and an em-dash (U+2014) as
// load-bearing output data (shown to the committer); written as escapes.
const NO_ENTRY_SIGN = '\u{26D4}';

/**
 * Block the commit ONCE iff >=1 ACTIONABLE (non-`skipped`) intent this run.
 *
 * Under Option A the production {@link RecordingInvoker} leaves every intent
 * `planned` -- the SKILL then authors each non-`skipped` intent in-session -- so
 * blocking only on `authored` would never gate the real path (the bug FIX 1
 * fixes). An intent is actionable when its `status != "skipped"` (`planned` OR
 * `authored`); an all-`skipped` run changed nothing, so it never blocks.
 * `authored_count` counts those actionable intents (the field name the
 * CLI/JSON/SKILL read). The message instructs "review ... then re-commit" (D4);
 * the actual sentinel write + `git add` happen in the hook/SKILL -- this is pure
 * decision logic.
 */
export function decideBlock(results: GeneratedTest[]): BlockDecision {
  const actionable = results.filter((r) => r.status !== 'skipped');
  const count = actionable.length;
  if (count === 0) {
    return new BlockDecision(false, '', 0);
  }
  const message =
    `${NO_ENTRY_SIGN} canary-guardian: ${count} test(s) authored & staged ` +
    `${EM_DASH} review the generated code, then re-commit.`;
  return new BlockDecision(true, message, count);
}
