import type {
  FullConfig,
  FullResult,
  Reporter,
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
}

/** @deprecated Use `IngestReporterOptions`. */
export type TestTrackerReporterOptions = IngestReporterOptions;

export interface ResolvedConfig {
  suite: string;
  testFilePrefix: string;
  environment?: string;
  url: string;
  token: string;
  workflow: string;
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
} as const;

/** Reads a setting's env var, falling back to its legacy name (recorded in `deprecated`). */
function envVar(
  env: NodeJS.ProcessEnv,
  key: keyof typeof ENV_NAMES,
  deprecated: string[] = [],
): string | undefined {
  const [current, legacy] = ENV_NAMES[key];
  if (env[current] !== undefined) return env[current];
  if (env[legacy] !== undefined) deprecated.push(legacy);
  return env[legacy];
}

export function resolveConfig(
  opts: IngestReporterOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const deprecatedEnv: string[] = [];
  const read = (key: keyof typeof ENV_NAMES) => envVar(env, key, deprecatedEnv);
  const suite = opts.suite ?? read("suite");
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
    deprecatedEnv,
  };
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

export function buildPayload(
  rawResults: ResultEntry[],
  cfg: ResolvedConfig,
  timing: { startedAt: string; finishedAt: string },
  env: NodeJS.ProcessEnv = process.env,
  fullResultStatus?: string,
  run: { shard?: Shard } = {},
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
  };
}

/** The subset of the ingest API's `POST /runs` response the reporter reads. */
export interface IngestResponse {
  id?: number;
  duplicate?: boolean;
  result_count?: number;
}

/**
 * What to tell the CI log about an ingest response. A `duplicate` answer is
 * only a harmless re-push when the stored run holds as many rows as this push
 * sent; otherwise this push's results were discarded, and that must not read
 * as a success line (#1148).
 */
export function ingestOutcome(
  data: IngestResponse,
  sent: { results: number },
): { level: "info" | "warn"; message: string } {
  const id = data.id ?? "?";
  if (!data.duplicate) return { level: "info", message: `run ${id} ingested.` };
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

export default class IngestReporter implements Reporter {
  private results = new Map<string, ResultEntry>();
  private startTime = Date.now();
  private cfg: ResolvedConfig | null = null;
  private shard: Shard = null;

  constructor(private options: IngestReporterOptions = {}) {}

  onBegin(config?: FullConfig) {
    this.shard = config?.shard ?? null;
    // Resolve config once; a config error here is logged, not thrown, so a
    // misconfigured reporter never aborts the whole run.
    try {
      this.cfg = resolveConfig(this.options);
      if (this.cfg.deprecatedEnv.length) {
        log(
          `${this.cfg.deprecatedEnv.join(", ")} ${this.cfg.deprecatedEnv.length > 1 ? "are" : "is"} deprecated; rename to CANARY_INGEST_* (see docs/wiki/Ingest-Reporter.md).`,
        );
      }
    } catch (err) {
      log(`disabled — ${errText(err)}`);
      this.cfg = null;
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.cfg) return;
    // A reporter hook must never fail the suite — guard the whole body.
    try {
      const fullTitle = test.titlePath().filter(Boolean).join(" > ");
      // `test.tags` requires Playwright >= 1.42; guard for the peer floor.
      const tags = (test.tags ?? []).map((t) => t.replace(/^@/, ""));
      // Keyed by the session-unique `test.id` (NOT the title) so `--repeat-each`
      // and duplicate-title executions don't collapse into one entry. Retries
      // share one TestCase (same id), so last-write-wins for the final status
      // and first-failing-attempt error preservation both still hold — a
      // recovered flake keeps the error that shows the SDET why it flaked.
      const prior = this.results.get(test.id);
      const interrupted = result.status === "interrupted";
      if (interrupted) tags.push("interrupted");
      const firstError = prior?.error_message ?? result.errors[0]?.message;
      this.results.set(test.id, {
        full_title: fullTitle,
        test_file: test.location.file.startsWith(this.cfg.testFilePrefix)
          ? test.location.file.slice(this.cfg.testFilePrefix.length)
          : test.location.file,
        status: resolveTestStatus(test.outcome(), result.status),
        duration_ms: result.duration,
        error_message: interrupted
          ? `interrupted: ${firstError ?? "the run ended before this test finished"}`
          : firstError,
        error_stack: prior?.error_stack ?? result.errors[0]?.stack,
        retries: result.retry,
        tags,
      });
    } catch (err) {
      log(`skipped a result — ${errText(err)}`);
    }
  }

  async onEnd(result: FullResult) {
    if (!this.cfg || !shouldPush(this.cfg)) return;
    try {
      const payload = buildPayload(
        [...this.results.values()],
        this.cfg,
        {
          startedAt: new Date(this.startTime).toISOString(),
          finishedAt: new Date().toISOString(),
        },
        process.env,
        result?.status,
        { shard: this.shard },
      );
      const resp = await fetch(`${this.cfg.url}/api/ingest/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.token}`,
        },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as IngestResponse;
        const outcome = ingestOutcome(data, { results: payload.results.length });
        if (outcome.level === "warn") warn(outcome.message);
        else log(outcome.message);
      } else {
        const text = await resp.text().catch(() => "");
        log(`push failed ${resp.status} — ${text.slice(0, 200)}`);
      }
    } catch (err) {
      log(`push error — ${errText(err)}`);
    }
  }
}
