import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import crypto from "node:crypto";

// Optional .env load — MUST NOT crash the suite if dotenv is absent.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
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

export function buildPayload(
  results: ResultEntry[],
  cfg: ResolvedConfig,
  timing: { startedAt: string; finishedAt: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const passed = count("passed");
  const failed = count("failed");
  const flaky = count("flaky");
  const skipped = count("skipped");
  const status = failed > 0 ? "failed" : flaky > 0 ? "flaky" : "passed";
  return {
    canary_run_id: stableRunId(env),
    suite: cfg.suite,
    branch: env.GITHUB_REF_NAME ?? "local",
    commit_sha: env.GITHUB_SHA,
    workflow: cfg.workflow,
    environment: cfg.environment,
    status,
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
    const fullTitle = test.titlePath().filter(Boolean).join(" > ");
    const tags = test.tags.map((t) => t.replace(/^@/, ""));
    // onTestEnd fires once per attempt; last write wins for the final status.
    // Preserve the FIRST failing attempt's error so a recovered flake still
    // shows the SDET why it flaked (the final passing attempt carries no error).
    const prior = this.results.get(fullTitle);
    this.results.set(fullTitle, {
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
  }

  async onEnd() {
    if (!this.cfg || !shouldPush(this.cfg)) return;
    const payload = buildPayload([...this.results.values()], this.cfg, {
      startedAt: new Date(this.startTime).toISOString(),
      finishedAt: new Date().toISOString(),
    });
    try {
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
