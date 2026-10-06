// Ingest reporter: the wire payload, statuses, dedupe and size budget.
import type { FullResult } from "@playwright/test/reporter";
import crypto from "node:crypto";
import type { ResolvedConfig } from "./config.js";

export interface ResultEntry {
  full_title: string;
  test_file: string;
  status: string;
  duration_ms?: number;
  error_message?: string;
  error_stack?: string;
  retries: number;
  tags: string[];
  area?: string;
}

/** One test the run collected, whether or not it ran (the suite's denominator). */
export interface CollectedEntry {
  full_title: string;
  test_file: string;
  tags: string[];
  area?: string;
}

/**
 * The wire contract POSTed to `/api/ingest/runs`. Declared explicitly (rather
 * than inferred from the object literal) so `declaration: true` ships a stable,
 * reviewable public type and an accidental field change is a compile error.
 */
export interface IngestPayload {
  canary_run_id: string;
  suite: string;
  branch: string;
  commit_sha?: string;
  workflow: string;
  environment?: string;
  status: "passed" | "failed" | "flaky" | "cancelled";
  started_at: string;
  finished_at: string;
  totals: {
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    total: number;
  };
  results: ResultEntry[];
  /**
   * Omitted = this push has no catalog (the dashboard reports the suite as
   * unmeasured); `[]` = a measured zero; non-empty = the suite's denominator.
   * The three are not interchangeable (#1150).
   */
  collected?: CollectedEntry[];
}

/**
 * Playwright status → the ingest result enum (`passed | failed | flaky |
 * skipped | timed_out`).
 *
 * `timedOut` keeps its own status: a timeout is often an environment or
 * performance signal, and triage differs (#1149). `interrupted` (run
 * cancelled, `maxFailures` hit, worker killed) has no ingest status, and
 * sending an unknown one rejects the whole run. It must not become `skipped`,
 * which drops the test out of the pass-rate denominator and makes a cut-short
 * run look clean, so it is sent as `failed`; `onTestEnd` tags it `interrupted`
 * and prefixes its error so it never reads as an assertion failure.
 */
export function mapStatus(pw: string): string {
  switch (pw) {
    case "passed":
      return "passed";
    case "failed":
    case "interrupted":
      return "failed";
    case "timedOut":
      return "timed_out";
    case "flaky":
      return "flaky";
    case "skipped":
    default:
      return "skipped";
  }
}

/**
 * Final per-test status, from `test.outcome()` first (#1186): `expected` is a
 * pass even for a `test.fail()` that failed (Playwright keeps the run green),
 * `unexpected` a failure even for one that passed. `flaky` (recovered on retry,
 * not a run failure; see buildPayload) and `skipped` pass through. Interrupted
 * goes first: outcome() ignores interrupted attempts, so it reads `skipped`.
 */
export function resolveTestStatus(outcome: string, lastAttemptStatus: string): string {
  if (lastAttemptStatus === "interrupted") return "failed"; // see mapStatus (#1149)
  if (outcome === "expected") return "passed";
  if (outcome === "unexpected") return lastAttemptStatus === "timedOut" ? "timed_out" : "failed";
  if (outcome === "flaky" || outcome === "skipped") return outcome;
  return mapStatus(lastAttemptStatus);
}

/** Playwright's `config.shard`: set while a shard runs, `null` under `merge-reports`. */
export type Shard = { current: number; total: number } | null | undefined;

/**
 * Ingest is idempotent on `(canary_run_id, suite)`, and every shard of one
 * workflow run shares `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT`. Without the shard
 * suffix the first shard to push wins and every later shard is answered
 * `duplicate: true` with its results discarded (#1148). The `-s2of4` form
 * matches `canary.run/1`'s shard-aware `run.id`.
 */
function stableRunId(env: NodeJS.ProcessEnv, shard: Shard): string {
  const runId = env.GITHUB_RUN_ID;
  if (!runId) {
    const sha = env.GITHUB_SHA?.slice(0, 7);
    return (sha ? `${sha}-` : "local-") + crypto.randomUUID();
  }
  const base = env.GITHUB_RUN_ATTEMPT ? `${runId}-${env.GITHUB_RUN_ATTEMPT}` : runId;
  return shard && shard.total > 1 ? `${base}-s${shard.current}of${shard.total}` : base;
}

/**
 * Overall run status. When Playwright reports the run as interrupted or timed
 * out, the run did NOT complete — do not derive a green status from whatever
 * per-test buckets happened to fill before the abort. `fullResultStatus` is
 * Playwright's `FullResult.status` (`passed` | `failed` | `timedout` | `interrupted`).
 */
export function runStatus(
  totals: { failed: number; flaky: number },
  fullResultStatus?: string,
): "passed" | "failed" | "flaky" | "cancelled" {
  if (fullResultStatus === "interrupted") return "cancelled";
  if (fullResultStatus === "timedout" || fullResultStatus === "failed") return "failed";
  // "passed" or unknown → trust the per-test buckets.
  if (totals.failed > 0) return "failed";
  if (totals.flaky > 0) return "flaky";
  return "passed";
}

/** Worst-first, so a collapsed row can never look healthier than its parts. */
const STATUS_SEVERITY: Record<string, number> = {
  failed: 3,
  timed_out: 3,
  flaky: 2,
  passed: 1,
  skipped: 0,
};

/**
 * Collapse results that share a `full_title` into one row.
 *
 * The ingest API holds a unique index on `(run_id, full_title)` and
 * rejects the WHOLE run on a collision, so a duplicate title is not a cosmetic
 * problem — it takes the suite dark. The reporter keys its in-flight map by
 * `test.id`, which is genuinely unique, but a title is not: a Playwright
 * `dependencies:` setup project runs in full in EVERY shard (dependencies are
 * not sharded), so a `merge-reports` payload over a sharded matrix legitimately
 * carries the same setup title once per shard. One consumer’s sharded suite
 * had every nightly rejected this way and never ingested a single run.
 *
 * Collapse rule keeps the merged row honest: worst status wins, the first real
 * error is preserved (so the SDET still sees why it failed), and duration and
 * retries take the max rather than the last-seen value.
 */
export function dedupeByFullTitle(results: ResultEntry[]): ResultEntry[] {
  const merged = new Map<string, ResultEntry>();
  for (const r of results) {
    const prior = merged.get(r.full_title);
    merged.set(r.full_title, prior ? mergeEntries(prior, r) : { ...r, tags: [...r.tags] });
  }
  return [...merged.values()];
}

function worstOf(a: string, b: string): string {
  return (STATUS_SEVERITY[b] ?? 0) > (STATUS_SEVERITY[a] ?? 0) ? b : a;
}

/** `Math.max` treats a missing duration as 0; absent-on-both must stay absent. */
function longerOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function mergeEntries(prior: ResultEntry, next: ResultEntry): ResultEntry {
  return {
    ...prior,
    status: worstOf(prior.status, next.status),
    error_message: prior.error_message ?? next.error_message,
    error_stack: prior.error_stack ?? next.error_stack,
    duration_ms: longerOf(prior.duration_ms, next.duration_ms),
    retries: Math.max(prior.retries, next.retries),
    tags: [...new Set([...prior.tags, ...next.tags])],
  };
}

/**
 * The run's real start and end. Under `merge-reports` the reporter only lives
 * for the merge (well under a second), but `FullResult.startTime`/`duration`
 * still describe the original run, so they win (#1176). The wall clock is the
 * fallback for a Playwright that does not report them.
 */
export function runTiming(
  result: Partial<Pick<FullResult, "startTime" | "duration">> | undefined,
  fallbackStart: number,
  now: number,
): { startedAt: string; finishedAt: string } {
  const start = result?.startTime?.getTime();
  if (start === undefined || Number.isNaN(start)) {
    return { startedAt: new Date(fallbackStart).toISOString(), finishedAt: new Date(now).toISOString() };
  }
  const end = Number.isFinite(result?.duration) ? start + (result?.duration as number) : now;
  return { startedAt: new Date(start).toISOString(), finishedAt: new Date(end).toISOString() };
}

export function buildPayload(
  rawResults: ResultEntry[],
  cfg: ResolvedConfig,
  timing: { startedAt: string; finishedAt: string },
  env: NodeJS.ProcessEnv = process.env,
  fullResultStatus?: string,
  run: { shard?: Shard; collected?: CollectedEntry[] | null } = {},
): IngestPayload {
  // Deduped before the totals are counted, so `totals` always describes the
  // rows actually sent — a payload whose totals disagree with `results.length`
  // would misreport the run on the dashboard.
  const results = dedupeByFullTitle(rawResults);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const passed = count("passed");
  // The ingest totals have no timed_out bucket; a timeout is a failure there.
  const failed = count("failed") + count("timed_out");
  const flaky = count("flaky");
  const skipped = count("skipped");
  return {
    canary_run_id: stableRunId(env, run.shard),
    suite: cfg.suite,
    branch: env.GITHUB_REF_NAME ?? "local",
    commit_sha: env.GITHUB_SHA,
    workflow: cfg.workflow,
    environment: cfg.environment,
    status: runStatus({ failed, flaky }, fullResultStatus),
    started_at: timing.startedAt,
    finished_at: timing.finishedAt,
    totals: { passed, failed, flaky, skipped, total: results.length },
    results,
    // null/undefined = no catalog for this push → the key is omitted, never `[]`.
    ...(run.collected ? { collected: run.collected } : {}),
  };
}

/** The subset of the ingest API's `POST /runs` response the reporter reads. */


/** The ingest body limit is 5 MB (and ~4.5 MB behind some proxies); stay under both. */
const MAX_BODY_BYTES = 4_000_000;

/**
 * Keeps a payload under the body limit. A 413 is a 4xx, so it is not retried
 * and the whole run would be lost, typically on a night with many large
 * failures. The catalog goes first (the run still lands, unmeasured), then
 * stacks are cut to 1 KB.
 */
export function fitPayload(
  payload: IngestPayload,
  maxBytes: number = MAX_BODY_BYTES,
): { payload: IngestPayload; warnings: string[] } {
  const warnings: string[] = [];
  const size = (p: IngestPayload) => Buffer.byteLength(JSON.stringify(p));
  let fitted = payload;
  if (size(fitted) > maxBytes && fitted.collected) {
    const { collected: _dropped, ...rest } = fitted;
    fitted = rest;
    warnings.push(`payload over ${maxBytes} bytes: collected was dropped, so this run's suite is unmeasured.`);
  }
  if (size(fitted) > maxBytes) {
    fitted = {
      ...fitted,
      results: fitted.results.map((r) => (r.error_stack ? { ...r, error_stack: r.error_stack.slice(0, 1000) } : r)),
    };
    warnings.push(`payload over ${maxBytes} bytes: error stacks were cut to 1 KB.`);
  }
  if (size(fitted) > maxBytes) {
    warnings.push(`payload is still over ${maxBytes} bytes; the dashboard may reject it.`);
  }
  return { payload: fitted, warnings };
}

export const MAX_ERROR_MESSAGE = 4_000;
export const MAX_ERROR_STACK = 8_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Playwright errors carry ANSI colour and full diffs; send readable, bounded text. */
export function errorField(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const plain = text.replace(ANSI, "");
  return plain.length > max ? `${plain.slice(0, max)}… [truncated]` : plain;
}
