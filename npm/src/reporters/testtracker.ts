import type {
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

export interface TestTrackerReporterOptions {
  suite?: string;
  /** Prefix stripped from an absolute test file path. Default: `<cwd>/`. */
  testFilePrefix?: string;
  /** Explicit environment label; else derived from env at push time. */
  environment?: string;
  url?: string;
  token?: string;
  workflow?: string;
}

export interface ResolvedConfig {
  suite: string;
  testFilePrefix: string;
  environment?: string;
  url: string;
  token: string;
  workflow: string;
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

export function mapStatus(pw: string): string {
  switch (pw) {
    case "passed":
      return "passed";
    case "failed":
    case "timedOut":
      return "failed";
    case "flaky":
      return "flaky";
    case "skipped":
    case "interrupted":
      return "skipped";
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

export function resolveConfig(
  opts: TestTrackerReporterOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const suite = opts.suite ?? env.TESTTRACKER_SUITE;
  if (!suite) {
    throw new Error(
      "TestTrackerReporter: `suite` is required (option or TESTTRACKER_SUITE).",
    );
  }
  return {
    suite,
    testFilePrefix:
      opts.testFilePrefix ?? env.TESTTRACKER_TEST_FILE_PREFIX ?? `${process.cwd()}/`,
    environment: opts.environment ?? env.TESTTRACKER_ENVIRONMENT,
    url: opts.url ?? env.TESTTRACKER_URL ?? "",
    token: opts.token ?? env.TESTTRACKER_API_TOKEN ?? "",
    workflow: opts.workflow ?? env.TESTTRACKER_WORKFLOW ?? "playwright",
  };
}

export function shouldPush(
  cfg: Pick<ResolvedConfig, "url" | "token">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!cfg.url || !cfg.token) return false;
  const isCI = env.CI === "true" || env.GITHUB_ACTIONS === "true";
  const force = env.TESTTRACKER_PUSH === "true";
  return isCI || force;
}

function stableRunId(env: NodeJS.ProcessEnv): string {
  const runId = env.GITHUB_RUN_ID;
  if (runId) return env.GITHUB_RUN_ATTEMPT ? `${runId}-${env.GITHUB_RUN_ATTEMPT}` : runId;
  const sha = env.GITHUB_SHA?.slice(0, 7);
  return (sha ? `${sha}-` : "local-") + crypto.randomUUID();
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
  flaky: 2,
  passed: 1,
  skipped: 0,
};

/**
 * Collapse results that share a `full_title` into one row.
 *
 * TestTracker's ingest holds a unique index on `(run_id, full_title)` and
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
): IngestPayload {
  // Deduped before the totals are counted, so `totals` always describes the
  // rows actually sent — a payload whose totals disagree with `results.length`
  // would misreport the run on the dashboard.
  const results = dedupeByFullTitle(rawResults);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const passed = count("passed");
  const failed = count("failed");
  const flaky = count("flaky");
  const skipped = count("skipped");
  return {
    canary_run_id: stableRunId(env),
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

export default class TestTrackerReporter implements Reporter {
  private results = new Map<string, ResultEntry>();
  private startTime = Date.now();
  private cfg: ResolvedConfig | null = null;

  constructor(private options: TestTrackerReporterOptions = {}) {}

  onBegin() {
    // Resolve config once; a config error here is logged, not thrown, so a
    // misconfigured reporter never aborts the whole run.
    try {
      this.cfg = resolveConfig(this.options);
    } catch (err) {
      console.log(
        `\nTestTracker: disabled — ${err instanceof Error ? err.message : String(err)}`,
      );
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
      this.results.set(test.id, {
        full_title: fullTitle,
        test_file: test.location.file.startsWith(this.cfg.testFilePrefix)
          ? test.location.file.slice(this.cfg.testFilePrefix.length)
          : test.location.file,
        status: resolveTestStatus(test.outcome(), result.status),
        duration_ms: result.duration,
        error_message: prior?.error_message ?? result.errors[0]?.message,
        error_stack: prior?.error_stack ?? result.errors[0]?.stack,
        retries: result.retry,
        tags,
      });
    } catch (err) {
      console.log(
        `\nTestTracker: skipped a result — ${err instanceof Error ? err.message : String(err)}`,
      );
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
        const data = (await resp.json().catch(() => ({}))) as {
          id?: number;
          duplicate?: boolean;
        };
        console.log(
          `\nTestTracker: run ${data.id ?? "?"} ingested${data.duplicate ? " (duplicate)" : ""}.`,
        );
      } else {
        const text = await resp.text().catch(() => "");
        console.log(`\nTestTracker: push failed ${resp.status} — ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(
        `\nTestTracker: push error — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
