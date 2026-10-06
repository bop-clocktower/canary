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
} as const satisfies Record<string, readonly [string] | readonly [string, string]>;

/** Reads a setting's env var, falling back to its legacy name (recorded in `deprecated`). */
function envVar(
  env: NodeJS.ProcessEnv,
  key: keyof typeof ENV_NAMES,
  deprecated: string[] = [],
): string | undefined {
  const [current, legacy] = ENV_NAMES[key] as readonly [string, string?];
  if (env[current] !== undefined || legacy === undefined) return env[current];
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
    areaMap: opts.areaMap ?? parseAreaMap(read("areaMap")),
    retryDelaysMs: opts.retryDelaysMs ?? [1000, 4000],
    titleFormat: parseTitleFormat(opts.titleFormat ?? read("titleFormat")),
    deprecatedEnv,
  };
}

function parseTitleFormat(raw: string | undefined): TitleFormat {
  if (raw === undefined || raw === "legacy") return "legacy";
  if (raw === "clean") return "clean";
  throw new Error(`titleFormat must be "legacy" or "clean" (got "${raw}").`);
}

/** Strips inline `@tag` tokens (they are already sent as `tags`), not `a@b` emails. */
function stripInlineTags(title: string): string {
  return title.replace(/(^|\s)@\S+/g, "$1").replace(/\s+/g, " ").trim();
}

/** Playwright reporter suites, innermost first, as far as the root. */
type SuiteLike = { type?: string; title: string; parent?: SuiteLike };

/** `describe… > title`, with inline tags stripped: the identity without project or file. */
function cleanTitle(test: TestCase): string {
  const parts = [test.title];
  for (let s = test.parent as SuiteLike | undefined; s && s.type === "describe"; s = s.parent) {
    parts.unshift(s.title);
  }
  return parts.map(stripInlineTags).filter(Boolean).join(" > ");
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

function parseAreaMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    /* fall through to the error below */
  }
  throw new Error('CANARY_INGEST_AREA_MAP must be a JSON object of glob → area, e.g. {"tests/rewards/**":"rewards"}.');
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
  const end = typeof result?.duration === "number" ? start + result.duration : now;
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

/**
 * POSTs with a bounded retry on 5xx, 429 and network errors. Ingest is
 * idempotent on `(canary_run_id, suite)`, so a retry can never double-count. A
 * 4xx is a payload problem and is never retried: the same bytes cannot succeed.
 */
async function postWithRetry(
  url: string,
  init: RequestInit,
  delaysMs: number[],
): Promise<{ resp?: Response; error?: unknown; attempts: number }> {
  let last: { resp?: Response; error?: unknown } = {};
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      const retryAfterS = Number(last.resp?.headers.get("retry-after"));
      const wait = Math.max(delaysMs[attempt - 1], Number.isFinite(retryAfterS) ? Math.min(retryAfterS, 30) * 1000 : 0);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const resp = await fetch(url, init);
      if (!retryable(resp.status)) return { resp, attempts: attempt + 1 };
      last = { resp };
    } catch (error) {
      last = { error };
    }
  }
  return { ...last, attempts: delaysMs.length + 1 };
}

/**
 * A clean title drops the file, so two different tests with the same
 * describe chain and title in different files would share one `full_title`
 * and be merged by the ingest key. Titles that collide across files keep a
 * `file > ` prefix, computed over results and catalog together so both use
 * the same identity.
 */
type Identified = { full_title: string; test_file: string };

export function disambiguateAcrossFiles<R extends Identified, C extends Identified>(
  results: R[],
  collected: C[] | null,
): { results: R[]; collected: C[] | null } {
  const files = new Map<string, Set<string>>();
  for (const row of [...results, ...(collected ?? [])]) {
    const set = files.get(row.full_title) ?? new Set<string>();
    set.add(row.test_file);
    files.set(row.full_title, set);
  }
  const fix = <T extends Identified>(row: T): T =>
    (files.get(row.full_title)?.size ?? 0) > 1 ? { ...row, full_title: `${row.test_file} > ${row.full_title}` } : row;
  return { results: results.map(fix), collected: collected?.map(fix) ?? null };
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
  /** Resolves false when the dashboard rejected the token before the run. */
  private preflight: Promise<boolean> | null = null;
  /** Projects other projects depend on (`dependencies`) or tear down with (`teardown`). */
  private setupProjects = new Set<string>();
  private teardownProjects = new Set<string>();

  constructor(private options: IngestReporterOptions = {}) {}

  onBegin(config?: FullConfig, suite?: Suite) {
    // Resolve config once; a config error here is logged, not thrown, so a
    // misconfigured reporter never aborts the whole run.
    this.shard = config?.shard ?? null;
    try {
      for (const project of config?.projects ?? []) {
        for (const dep of project.dependencies ?? []) this.setupProjects.add(dep);
        if (project.teardown) this.teardownProjects.add(project.teardown);
      }
    } catch (err) {
      // Costs only the setup/teardown tags; the run is still pushed.
      log(`could not read the project list — ${errText(err)}`);
    }
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
      return;
    }
    this.collected = this.collectCatalog(suite);
    if (shouldPush(this.cfg)) this.preflight = this.checkToken(this.cfg);
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
        ...(project && this.setupProjects.has(project) ? ["setup"] : []),
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
   * Every collected test, as the suite's denominator (#1150). A shard only
   * sees its own slice, and a partial list would overwrite the suite's real
   * denominator, so a shard push sends no catalog; `merge-reports` (shard
   * `null`) sees the whole suite and sends it.
   */
  private collectCatalog(suite: Suite | undefined): CollectedEntry[] | null {
    if (!this.cfg || !suite || (this.shard && this.shard.total > 1)) return null;
    try {
      // Keyed by file and title: the same test across projects is one row, but
      // a clean title shared by two files must survive to be disambiguated.
      const byIdentity = new Map<string, CollectedEntry>();
      for (const test of suite.allTests()) {
        const entry = this.describeTest(test, this.cfg);
        const key = `${entry.test_file}\0${entry.full_title}`;
        const prior = byIdentity.get(key);
        byIdentity.set(key, prior ? { ...prior, tags: [...new Set([...prior.tags, ...entry.tags])] } : entry);
      }
      return [...byIdentity.values()];
    } catch (err) {
      log(`collected catalog unavailable — ${errText(err)}`);
      return null;
    }
  }

  /**
   * Asks the dashboard which tenant the token writes to before any test runs,
   * so a wrong or revoked token shows up at the top of the log rather than
   * after the suite. Only a 401/403 stops the push; an unreachable endpoint or
   * an older dashboard without `/whoami` must not.
   */
  private async checkToken(cfg: ResolvedConfig): Promise<boolean> {
    try {
      const resp = await fetch(`${cfg.url}/api/ingest/whoami`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (resp.status === 401 || resp.status === 403) {
        warn(`token rejected at preflight (${resp.status}); this run will not be pushed. Check CANARY_INGEST_TOKEN.`);
        return false;
      }
      if (resp.ok) {
        const who = (await resp.json().catch(() => ({}))) as {
          tenant?: { slug?: string };
          token?: { name?: string };
        };
        log(`pushing to tenant ${who.tenant?.slug ?? "?"} with token "${who.token?.name ?? "?"}".`);
      }
    } catch {
      /* unreachable now; the push reports its own failure */
    }
    return true;
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
      const firstError = prior?.error_message ?? result.errors[0]?.message;
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
        error_stack: prior?.error_stack ?? result.errors[0]?.stack,
        retries: result.retry,
      });
    } catch (err) {
      log(`skipped a result — ${errText(err)}`);
    }
  }

  async onEnd(result: FullResult) {
    if (!this.cfg || !shouldPush(this.cfg)) return;
    if (this.preflight && !(await this.preflight)) return;
    try {
      let rows = { results: [...this.results.values()], collected: this.collected };
      if (this.cfg.titleFormat === "clean") rows = disambiguateAcrossFiles(rows.results, rows.collected);
      const payload = buildPayload(
        rows.results,
        this.cfg,
        runTiming(result, this.startTime, Date.now()),
        process.env,
        result?.status,
        { shard: this.shard, collected: rows.collected },
      );
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
