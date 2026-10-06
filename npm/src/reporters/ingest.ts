import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import crypto from "node:crypto";

// Optional .env load — MUST NOT crash the suite if dotenv is absent.
try {
  require("dotenv").config();
} catch {
  /* dotenv not installed — use ambient env */
}

/**
 * Pushes a completed Playwright run to an `/api/ingest` endpoint (a QA
 * dashboard's ingest API). Loaded by consumers as `canary-test-cli/reporter`.
 *
 * Formerly the "TestTracker reporter": the `TESTTRACKER_*` env vars it used to
 * read still work for one release (see `envVar`) and are reported as deprecated.
 */
export interface IngestReporterOptions {
  suite?: string;
  /** Prefix stripped from an absolute test file path. Default: `<cwd>/`. */
  testFilePrefix?: string;
  /** Explicit environment label; else derived from env at push time. */
  environment?: string;
  url?: string;
  token?: string;
  workflow?: string;
  /**
   * Glob → product area for a test's repo-relative file, first match wins
   * (`{ "tests/**\/rewards/**": "rewards" }`). A test annotation
   * `{ type: "area", description }` wins over the map. Unmapped tests send no
   * area, so the dashboard never shows a folder name as a product area.
   */
  areaMap?: Record<string, string>;
  /** Waits before each retry of a 5xx/429/network failure. Default `[1000, 4000]` (3 attempts). */
  retryDelaysMs?: number[];
  /**
   * `legacy` (default): `project > file > describe… > title`, the identity
   * existing dashboards key history on. `clean`: `describe… > title` with
   * inline `@tag` tokens stripped. Switching changes every test's identity
   * (quarantine entries, flake history), so it is opt-in (#1183).
   */
  titleFormat?: TitleFormat;
  /**
   * Send `collected` (the suite's denominator) when the run is unfiltered.
   * Default `true`; set `false` (`CANARY_INGEST_COLLECTED=false`) on a job
   * that runs a subset the reporter cannot detect (`--last-failed`,
   * `--only-changed`).
   */
  collected?: boolean;
}

export type TitleFormat = "legacy" | "clean";

/** @deprecated Use `IngestReporterOptions`. */
export type TestTrackerReporterOptions = IngestReporterOptions;

export interface ResolvedConfig {
  suite: string;
  testFilePrefix: string;
  environment?: string;
  url: string;
  token: string;
  workflow: string;
  areaMap: Record<string, string>;
  retryDelaysMs: number[];
  titleFormat: TitleFormat;
  collected: boolean;
  /** Optional settings that were invalid and fell back to their default. */
  configWarnings: string[];
  /** Legacy `TESTTRACKER_*` names this config was resolved from. */
  deprecatedEnv: string[];
}

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
 * Final per-test status, flaky-aware. Playwright's per-attempt
 * `result.status` is NEVER "flaky" — flakiness is derived at the test level
 * (a test that failed then passed on retry). `test.outcome()` is the canonical
 * signal, so a recovered flake is reported as "flaky" (SDET-visible) rather
 * than the last attempt's "passed". A recovered flake does NOT count as a
 * failure at the run level (see buildPayload) — management sees a good run.
 */
export function resolveTestStatus(outcome: string, lastAttemptStatus: string): string {
  if (outcome === "flaky") return "flaky";
  return mapStatus(lastAttemptStatus);
}

/** Each setting's env var, and the pre-rename name still accepted for it. */
const ENV_NAMES = {
  suite: ["CANARY_INGEST_SUITE", "TESTTRACKER_SUITE"],
  testFilePrefix: ["CANARY_INGEST_TEST_FILE_PREFIX", "TESTTRACKER_TEST_FILE_PREFIX"],
  environment: ["CANARY_INGEST_ENVIRONMENT", "TESTTRACKER_ENVIRONMENT"],
  url: ["CANARY_INGEST_URL", "TESTTRACKER_URL"],
  token: ["CANARY_INGEST_TOKEN", "TESTTRACKER_API_TOKEN"],
  workflow: ["CANARY_INGEST_WORKFLOW", "TESTTRACKER_WORKFLOW"],
  push: ["CANARY_INGEST_PUSH", "TESTTRACKER_PUSH"],
  areaMap: ["CANARY_INGEST_AREA_MAP"],
  titleFormat: ["CANARY_INGEST_TITLE_FORMAT"],
  collected: ["CANARY_INGEST_COLLECTED"],
} as const satisfies Record<string, readonly [string] | readonly [string, string]>;

/**
 * Reads a setting's env var, falling back to its legacy name (recorded in
 * `deprecated`). Empty counts as unset: GitHub Actions expands a secret that
 * does not exist yet to "", and that must not hide a working legacy value.
 */
function envVar(
  env: NodeJS.ProcessEnv,
  key: keyof typeof ENV_NAMES,
  deprecated: string[] = [],
): string | undefined {
  const [current, legacy] = ENV_NAMES[key] as readonly [string, string?];
  if (env[current] || legacy === undefined) return env[current] || undefined;
  if (env[legacy]) deprecated.push(legacy);
  return env[legacy] || undefined;
}

export function resolveConfig(
  opts: IngestReporterOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const deprecatedEnv: string[] = [];
  const configWarnings: string[] = [];
  const read = (key: keyof typeof ENV_NAMES) => envVar(env, key, deprecatedEnv);
  const suite = opts.suite || read("suite");
  if (!suite) {
    throw new Error("`suite` is required (option or CANARY_INGEST_SUITE).");
  }
  return {
    suite,
    testFilePrefix: opts.testFilePrefix ?? read("testFilePrefix") ?? `${process.cwd()}/`,
    environment: opts.environment ?? read("environment"),
    url: opts.url ?? read("url") ?? "",
    token: opts.token ?? read("token") ?? "",
    workflow: opts.workflow ?? read("workflow") ?? "playwright",
    areaMap: checkAreaMap(opts.areaMap ?? parseAreaMap(read("areaMap"), configWarnings), configWarnings),
    retryDelaysMs: opts.retryDelaysMs ?? [1000, 4000],
    titleFormat: parseTitleFormat(opts.titleFormat ?? read("titleFormat"), configWarnings),
    collected: opts.collected ?? read("collected") !== "false",
    deprecatedEnv,
    configWarnings,
  };
}

/*
 * Optional settings degrade to their default with a warning rather than
 * throwing: a typo in one must never turn pushing off for the whole suite.
 */

function parseTitleFormat(raw: string | undefined, warnings: string[]): TitleFormat {
  if (raw === undefined || raw === "legacy") return "legacy";
  if (raw === "clean") return "clean";
  warnings.push(`titleFormat must be "legacy" or "clean" (got "${raw}"); using legacy.`);
  return "legacy";
}

/** Playwright reporter suites, innermost first, as far as the root. */
type SuiteLike = { type?: string; title: string; parent?: SuiteLike };

/**
 * `file > describe… > title`: the legacy title without the project. Every
 * part comes from the test itself, so the identity never depends on which
 * other tests are in a push and two tests never share it.
 */
function cleanTitle(test: TestCase): string {
  const parts = [test.title];
  for (let s = test.parent as SuiteLike | undefined; s && (s.type === "describe" || s.type === "file"); s = s.parent) {
    parts.unshift(s.title);
  }
  return parts.filter(Boolean).join(" > ");
}

function projectName(test: TestCase): string | undefined {
  for (let s = test.parent as SuiteLike | undefined; s; s = s.parent) {
    if (s.type === "project") return s.title || undefined;
  }
  return undefined;
}

/** The longest `reason:` tag; enough for an issue ref and a sentence. */
const MAX_REASON = 100;

/**
 * Tags that say why a test did not run: `fixme`, and `reason:<text>` from a
 * fixme/skip annotation's description (often an issue ref). The ingest API
 * has no skip-reason field, so the reason rides as a tag (#1183).
 */
function skipTags(annotations: ReadonlyArray<{ type: string; description?: string }>): string[] {
  const tags: string[] = [];
  for (const a of annotations) {
    if (a.type !== "fixme" && a.type !== "skip") continue;
    if (a.type === "fixme") tags.push("fixme");
    const reason = a.description?.replace(/\s+/g, " ").trim();
    if (reason) tags.push(`reason:${reason.slice(0, MAX_REASON)}`);
  }
  return tags;
}

function parseAreaMap(raw: string | undefined, warnings: string[]): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    /* fall through to the warning below */
  }
  warnings.push(
    'CANARY_INGEST_AREA_MAP must be a JSON object of glob → area, e.g. {"tests/rewards/**":"rewards"}; sending no areas.',
  );
  return {};
}

/** Only `**`, `*` and `?` are glob syntax here; `{a,b}` and `[ab]` would match as literal text. */
function checkAreaMap(map: Record<string, string>, warnings: string[]): Record<string, string> {
  for (const glob of Object.keys(map)) {
    if (/[{}[\]]/.test(glob)) {
      warnings.push(`areaMap glob "${glob}" uses unsupported {a,b} or [ab] syntax and matches only literally; list each path instead.`);
    }
  }
  return map;
}

/** `**` crosses directories, `*` and `?` stay within one path segment. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * A test's product area: an `area` annotation, else the first `areaMap` glob
 * matching its repo-relative file, else none. Never a folder-name guess.
 */
export function resolveArea(
  annotations: ReadonlyArray<{ type: string; description?: string }>,
  testFile: string,
  areaMap: Record<string, string>,
): string | undefined {
  const annotated = annotations.find((a) => a.type === "area" && a.description)?.description;
  if (annotated) return annotated;
  for (const [glob, area] of Object.entries(areaMap)) {
    if (globToRegExp(glob).test(testFile)) return area;
  }
  return undefined;
}

export function shouldPush(
  cfg: Pick<ResolvedConfig, "url" | "token">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!cfg.url || !cfg.token) return false;
  const isCI = env.CI === "true" || env.GITHUB_ACTIONS === "true";
  const force = envVar(env, "push") === "true";
  return isCI || force;
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
export interface IngestResponse {
  id?: number;
  duplicate?: boolean;
  result_count?: number;
  /** `null` when the dashboard recorded no catalog (including on a duplicate re-push). */
  collected_count?: number | null;
}

/**
 * What to tell the CI log about an ingest response. A `duplicate` answer is
 * only a harmless re-push when the stored run holds as many rows as this push
 * sent; otherwise this push's results were discarded, and that must not read
 * as a success line (#1148).
 */
export function ingestOutcome(
  data: IngestResponse,
  sent: { results: number; collected?: number },
): { level: "info" | "warn"; message: string } {
  const id = data.id ?? "?";
  if (!data.duplicate) {
    // Only checkable on a fresh ingest: a re-push records no catalog (null).
    if (sent.collected !== undefined && typeof data.collected_count === "number" && data.collected_count !== sent.collected) {
      return {
        level: "warn",
        message: `run ${id} ingested, but the dashboard recorded ${data.collected_count} collected tests and this push sent ${sent.collected}; the suite's denominator is wrong.`,
      };
    }
    return { level: "info", message: `run ${id} ingested.` };
  }
  if (data.result_count !== undefined && data.result_count !== sent.results) {
    return {
      level: "warn",
      message:
        `run ${id} was a duplicate: the stored run has ${data.result_count} results, this push sent ${sent.results}, ` +
        "and this push's results were discarded. Two jobs pushed the same suite under one run id; " +
        "push once per suite (merge-reports for sharded suites).",
    };
  }
  return { level: "info", message: `run ${id} already ingested (duplicate re-push).` };
}

/** A warning that must not scroll past: also raised as a GitHub Actions annotation. */
function warn(message: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_ACTIONS === "true") console.log(`::warning title=canary ingest::${message}`);
  log(`WARNING — ${message}`);
}

function log(message: string): void {
  console.log(`\ncanary ingest: ${message}`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for an answer worth retrying: the server's side, or rate limiting. */
function retryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Longest wait a `Retry-After` can ask for; the dashboard's rate window is 60 s. */
const MAX_RETRY_AFTER_MS = 65_000;

/**
 * How long to wait before a retry: the backoff, or the server's `Retry-After`
 * (seconds) when longer, capped at 65 s. A date-form `Retry-After` is ignored.
 */
export function retryWaitMs(backoffMs: number, retryAfter: string | null | undefined): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const asked = Number.isFinite(seconds) ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 0;
  return Math.max(backoffMs, asked);
}

/** Per-request time limits; Playwright awaits `onEnd` with no limit of its own. */
const PREFLIGHT_TIMEOUT_MS = 5_000;
const POST_TIMEOUT_MS = 30_000;

/**
 * POSTs with a bounded retry on 5xx, 429 and network errors (a timeout is a
 * network error). Ingest is idempotent on `(canary_run_id, suite)`, so a
 * retry can never double-count. A 4xx is a payload problem and is never
 * retried: the same bytes cannot succeed.
 */
async function postWithRetry(
  url: string,
  init: RequestInit,
  delaysMs: number[],
): Promise<{ resp?: Response; error?: unknown; attempts: number }> {
  let last: { resp?: Response; error?: unknown } = {};
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      const wait = retryWaitMs(delaysMs[attempt - 1], last.resp?.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
      if (!retryable(resp.status)) return { resp, attempts: attempt + 1 };
      last = { resp };
    } catch (error) {
      last = { error };
    }
  }
  return { ...last, attempts: delaysMs.length + 1 };
}

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

const MAX_ERROR_MESSAGE = 4_000;
const MAX_ERROR_STACK = 8_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Playwright errors carry ANSI colour and full diffs; send readable, bounded text. */
function errorField(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const plain = text.replace(ANSI, "");
  return plain.length > max ? `${plain.slice(0, max)}… [truncated]` : plain;
}

/**
 * Why `collected` would not be the whole suite, or null when it is. A
 * filtered run's `allTests()` is only the subset that ran, and sending it
 * would shrink the suite's denominator on the dashboard (#1150). Playwright
 * does not expose `--last-failed`/`--only-changed` to a reporter; those jobs
 * opt out with `collected: false`.
 */
export function catalogFilter(config: FullConfig | undefined, suite: Suite | undefined): string | null {
  if (!config) return null;
  if (config.shard && config.shard.total > 1) return `this is shard ${config.shard.current} of ${config.shard.total}`;
  const greps = [config.grep].flat().filter(Boolean) as RegExp[];
  if (greps.some((g) => g.source !== ".*")) return "the run is filtered by --grep";
  if ([config.grepInvert].flat().filter(Boolean).length) return "the run is filtered by --grep-invert";
  const configured = (config.projects ?? []).map((p) => p.name);
  const present = new Set((suite?.suites ?? []).filter((s) => s.type === "project").map((s) => s.title));
  const missing = configured.filter((name) => !present.has(name));
  if (configured.length && missing.length) return `project(s) ${missing.join(", ")} did not run`;
  return null;
}

const INTERRUPTED_PREFIX = "interrupted: ";

function relativeFile(file: string, prefix: string): string {
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

export default class IngestReporter implements Reporter {
  private results = new Map<string, ResultEntry>();
  private startTime = Date.now();
  private cfg: ResolvedConfig | null = null;
  private shard: Shard = null;
  private collected: CollectedEntry[] | null = null;
  private collectedCount = 0;
  private preflight: Promise<void> | null = null;
  /** Projects other projects depend on (`dependencies`) or tear down with (`teardown`). */
  private dependencyProjects = new Set<string>();
  private teardownProjects = new Set<string>();

  constructor(private options: IngestReporterOptions = {}) {}

  onBegin(config?: FullConfig, suite?: Suite) {
    this.shard = config?.shard ?? null;
    try {
      for (const project of config?.projects ?? []) {
        for (const dep of project.dependencies ?? []) this.dependencyProjects.add(dep);
        if (project.teardown) this.teardownProjects.add(project.teardown);
      }
    } catch (err) {
      // Costs only the dependency/teardown tags; the run is still pushed.
      log(`could not read the project list — ${errText(err)}`);
    }
    // Resolve config once; a config error here is logged, not thrown, so a
    // misconfigured reporter never aborts the whole run.
    try {
      this.cfg = resolveConfig(this.options);
    } catch (err) {
      // Loud when the run was clearly meant to be pushed, quiet otherwise.
      const meant = envVar(process.env, "url") && envVar(process.env, "token");
      (meant || this.options.url ? warn : log)(`disabled — ${errText(err)}`);
      this.cfg = null;
      return;
    }
    if (this.cfg.deprecatedEnv.length) {
      log(
        `${this.cfg.deprecatedEnv.join(", ")} ${this.cfg.deprecatedEnv.length > 1 ? "are" : "is"} deprecated; rename to CANARY_INGEST_* (see docs/wiki/Ingest-Reporter.md).`,
      );
    }
    for (const w of this.cfg.configWarnings) warn(w);
    try {
      this.collectedCount = suite?.allTests().length ?? 0;
    } catch {
      this.collectedCount = 0;
    }
    this.collected = this.collectCatalog(config, suite);
    if (shouldPush(this.cfg)) {
      this.preflight = this.checkToken(this.cfg);
    } else if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
      // A silent skip in CI reads exactly like a clean push; name what is missing.
      const missing = [!this.cfg.url && "CANARY_INGEST_URL", !this.cfg.token && "CANARY_INGEST_TOKEN"].filter(Boolean);
      if (missing.length) log(`not pushing: ${missing.join(" and ")} not set.`);
    }
  }

  /** The fields a test has whether or not it ran: identity, tags and area. */
  private describeTest(test: TestCase, cfg: ResolvedConfig): CollectedEntry {
    const testFile = relativeFile(test.location.file, cfg.testFilePrefix);
    const annotations = test.annotations ?? [];
    const project = projectName(test);
    // `test.tags` requires Playwright >= 1.42; guard for the peer floor.
    // A tag in both a describe title and the test title appears twice in
    // `test.tags`; per-tag counts must see it once (#1176).
    const tags = [
      ...new Set([
        ...(test.tags ?? []).map((t) => t.replace(/^@/, "")),
        // The project is otherwise only visible inside a legacy title, and not
        // at all in a clean one; a tag gives the dashboard the dimension (#1183).
        ...(project ? [`project:${project}`] : []),
        // Neutral on purpose: a dependency project may be setup or a real
        // suite (api before e2e); the dashboard decides what to filter.
        ...(project && this.dependencyProjects.has(project) ? ["dependency"] : []),
        ...(project && this.teardownProjects.has(project) ? ["teardown"] : []),
        ...skipTags(annotations),
      ]),
    ];
    const area = resolveArea(annotations, testFile, cfg.areaMap);
    return {
      full_title:
        cfg.titleFormat === "clean" ? cleanTitle(test) : test.titlePath().filter(Boolean).join(" > "),
      test_file: testFile,
      tags,
      ...(area ? { area } : {}),
    };
  }

  /**
   * Every collected test, as the suite's denominator (#1150), or null when the
   * run is filtered (see `catalogFilter`) or the job opted out.
   */
  private collectCatalog(config: FullConfig | undefined, suite: Suite | undefined): CollectedEntry[] | null {
    if (!this.cfg || !suite || !this.cfg.collected) return null;
    try {
      const filter = catalogFilter(config, suite);
      if (filter) {
        log(`collected not sent: ${filter}, so this run is not the whole suite.`);
        return null;
      }
      // Keyed by title (which carries the file in both formats): the same test
      // across projects is one row.
      const byTitle = new Map<string, CollectedEntry>();
      for (const test of suite.allTests()) {
        const entry = this.describeTest(test, this.cfg);
        const prior = byTitle.get(entry.full_title);
        byTitle.set(entry.full_title, prior ? { ...prior, tags: [...new Set([...prior.tags, ...entry.tags])] } : entry);
      }
      return [...byTitle.values()];
    } catch (err) {
      log(`collected catalog unavailable — ${errText(err)}`);
      return null;
    }
  }

  /**
   * Asks the dashboard which tenant the token writes to before any test runs,
   * so a wrong token shows up at the top of the log rather than after the
   * suite. Advisory only: the POST's own answer is the verdict, because
   * `/whoami` can sit behind different auth (or a WAF) than ingest.
   */
  private async checkToken(cfg: ResolvedConfig): Promise<void> {
    try {
      const resp = await fetch(`${cfg.url}/api/ingest/whoami`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });
      if (resp.status === 401 || resp.status === 403) {
        warn(`token rejected at preflight (${resp.status}); the push will still be tried. Check CANARY_INGEST_TOKEN.`);
      } else if (resp.ok) {
        const who = (await resp.json().catch(() => ({}))) as {
          tenant?: { slug?: string };
          token?: { name?: string };
        };
        log(`pushing to tenant ${who.tenant?.slug ?? "?"} with token "${who.token?.name ?? "?"}".`);
      }
    } catch {
      /* unreachable or slow now; the push reports its own failure */
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.cfg) return;
    // A reporter hook must never fail the suite — guard the whole body.
    try {
      const described = this.describeTest(test, this.cfg);
      // Keyed by the session-unique `test.id` (NOT the title) so `--repeat-each`
      // and duplicate-title executions don't collapse into one entry. Retries
      // share one TestCase (same id), so last-write-wins for the final status
      // and first-failing-attempt error preservation both still hold — a
      // recovered flake keeps the error that shows the SDET why it flaked.
      const prior = this.results.get(test.id);
      const interrupted = result.status === "interrupted";
      if (interrupted) described.tags.push("interrupted");
      const firstError = prior?.error_message ?? errorField(result.errors[0]?.message, MAX_ERROR_MESSAGE);
      this.results.set(test.id, {
        ...described,
        status: resolveTestStatus(test.outcome(), result.status),
        // The ingest schema requires a non-negative integer: a float or the -1
        // Playwright reports for a test that never started rejects the whole run.
        duration_ms: result.duration >= 0 ? Math.round(result.duration) : undefined,
        error_message:
          interrupted && !firstError?.startsWith(INTERRUPTED_PREFIX)
            ? `${INTERRUPTED_PREFIX}${firstError ?? "the run ended before this test finished"}`
            : firstError,
        error_stack: prior?.error_stack ?? errorField(result.errors[0]?.stack, MAX_ERROR_STACK),
        retries: result.retry,
      });
    } catch (err) {
      log(`skipped a result — ${errText(err)}`);
    }
  }

  async onEnd(result: FullResult) {
    if (!this.cfg || !shouldPush(this.cfg)) return;
    await this.preflight;
    if (this.results.size === 0 && this.collectedCount > 0) {
      // `playwright test --list` and fully-filtered runs: a green run in which
      // nothing ran would read as real coverage.
      log("no test ran (list mode or everything filtered out); nothing pushed.");
      return;
    }
    try {
      const { payload, warnings } = fitPayload(
        buildPayload(
          [...this.results.values()],
          this.cfg,
          runTiming(result, this.startTime, Date.now()),
          process.env,
          result?.status,
          { shard: this.shard, collected: this.collected },
        ),
      );
      for (const w of warnings) warn(w);
      const { resp, error, attempts } = await postWithRetry(
        `${this.cfg.url}/api/ingest/runs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.cfg.token}`,
          },
          body: JSON.stringify(payload),
        },
        this.cfg.retryDelaysMs,
      );
      if (resp?.ok) {
        const data = (await resp.json().catch(() => ({}))) as IngestResponse;
        const outcome = ingestOutcome(data, {
          results: payload.results.length,
          collected: payload.collected?.length,
        });
        if (outcome.level === "warn") warn(outcome.message);
        else log(outcome.message);
        return;
      }
      const why = resp ? `${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}` : errText(error);
      warn(
        resp && !retryable(resp.status)
          ? `push rejected (${why}); run not ingested. A 4xx is a payload problem and is not retried.`
          : `run not ingested after ${attempts} attempts (${why}).`,
      );
    } catch (err) {
      warn(`push error — ${errText(err)}; run not ingested.`);
    }
  }
}
