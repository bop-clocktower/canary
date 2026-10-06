import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { envVar, resolveConfig, resolveArea, shouldPush } from "./ingest/config.js";
import { runTiming, buildPayload, fitPayload, resolveTestStatus, errorField, MAX_ERROR_MESSAGE, MAX_ERROR_STACK, mapStatus, runStatus, dedupeByFullTitle } from "./ingest/payload.js";
import { cleanTitle, projectName, skipTags, catalogFilter, relativeFile } from "./ingest/describe.js";
import { warn, log, errText, PREFLIGHT_TIMEOUT_MS, push, ingestOutcome, retryWaitMs } from "./ingest/transport.js";
import type { IngestReporterOptions, ResolvedConfig } from "./ingest/config.js";
import type { ResultEntry, CollectedEntry, Shard } from "./ingest/payload.js";

// Optional .env load — MUST NOT crash the suite if dotenv is absent.
try {
  require("dotenv").config();
} catch {
  /* dotenv not installed — use ambient env */
}

/** The public surface consumers import from `canary-test-cli/reporter`. */
export { resolveConfig, resolveArea, shouldPush, mapStatus, resolveTestStatus, runStatus, dedupeByFullTitle, runTiming, buildPayload, fitPayload, catalogFilter, ingestOutcome, retryWaitMs };
export type { IngestReporterOptions, TitleFormat, TestTrackerReporterOptions, ResolvedConfig } from "./ingest/config.js";
export type { ResultEntry, CollectedEntry, IngestPayload, Shard } from "./ingest/payload.js";
export type { IngestResponse } from "./ingest/transport.js";

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
    this.readProjects(config);
    this.cfg = this.initConfig();
    if (!this.cfg) return;
    this.collectedCount = countTests(suite);
    this.collected = this.collectCatalog(config, suite);
    if (shouldPush(this.cfg)) this.preflight = this.checkToken(this.cfg);
    else explainNoPush(this.cfg);
  }

  /** Which projects are other projects' dependencies or teardowns. */
  private readProjects(config: FullConfig | undefined): void {
    try {
      for (const project of config?.projects ?? []) {
        for (const dep of project.dependencies ?? []) this.dependencyProjects.add(dep);
        if (project.teardown) this.teardownProjects.add(project.teardown);
      }
    } catch (err) {
      // Costs only the dependency/teardown tags; the run is still pushed.
      log(`could not read the project list — ${errText(err)}`);
    }
  }

  /**
   * Resolves config once. A config error is logged, not thrown, so a
   * misconfigured reporter never aborts the whole run; it is a warning when
   * the run was clearly meant to be pushed.
   */
  private initConfig(): ResolvedConfig | null {
    let cfg: ResolvedConfig;
    try {
      cfg = resolveConfig(this.options);
    } catch (err) {
      const meant = Boolean(this.options.url || (envVar(process.env, "url") && envVar(process.env, "token")));
      (meant ? warn : log)(`disabled — ${errText(err)}`);
      return null;
    }
    if (cfg.deprecatedEnv.length) {
      const verb = cfg.deprecatedEnv.length > 1 ? "are" : "is";
      log(`${cfg.deprecatedEnv.join(", ")} ${verb} deprecated; rename to CANARY_INGEST_* (see docs/wiki/Ingest-Reporter.md).`);
    }
    for (const w of cfg.configWarnings) warn(w);
    return cfg;
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
      // Keyed by the session-unique `test.id` (NOT the title) so `--repeat-each`
      // and duplicate-title executions don't collapse into one entry. Retries
      // share one TestCase (same id), so last-write-wins for the final status
      // and first-failing-attempt error preservation both still hold — a
      // recovered flake keeps the error that shows the SDET why it flaked.
      const entry = resultEntry(this.describeTest(test, this.cfg), test, result, this.results.get(test.id));
      this.results.set(test.id, entry);
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
      const raw = buildPayload(
        [...this.results.values()],
        this.cfg,
        runTiming(result, this.startTime, Date.now()),
        process.env,
        result?.status,
        { shard: this.shard, collected: this.collected },
      );
      const { payload, warnings } = fitPayload(raw);
      for (const w of warnings) warn(w);
      await push(this.cfg, payload);
    } catch (err) {
      warn(`push error — ${errText(err)}; run not ingested.`);
    }
  }
}

function countTests(suite: Suite | undefined): number {
  try {
    return suite?.allTests().length ?? 0;
  } catch {
    return 0;
  }
}

/** A silent skip in CI reads exactly like a clean push; name what is missing. */
function explainNoPush(cfg: ResolvedConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (env.CI !== "true" && env.GITHUB_ACTIONS !== "true") return;
  const missing = [!cfg.url && "CANARY_INGEST_URL", !cfg.token && "CANARY_INGEST_TOKEN"].filter(Boolean);
  if (missing.length) log(`not pushing: ${missing.join(" and ")} not set.`);
}

/** The final per-test row: what it is (`described`) plus how this attempt went. */
function resultEntry(
  described: CollectedEntry,
  test: TestCase,
  result: TestResult,
  prior: ResultEntry | undefined,
): ResultEntry {
  const interrupted = result.status === "interrupted";
  const firstError = prior?.error_message ?? errorField(result.errors[0]?.message, MAX_ERROR_MESSAGE);
  return {
    ...described,
    tags: interrupted ? [...described.tags, "interrupted"] : described.tags,
    status: resolveTestStatus(test.outcome(), result.status),
    // The ingest schema requires a non-negative integer: a float or the -1
    // Playwright reports for a test that never started rejects the whole run.
    duration_ms: result.duration >= 0 ? Math.round(result.duration) : undefined,
    error_message: interrupted ? interruptedMessage(firstError) : firstError,
    error_stack: prior?.error_stack ?? errorField(result.errors[0]?.stack, MAX_ERROR_STACK),
    retries: result.retry,
  };
}

const INTERRUPTED_PREFIX = "interrupted: ";

function interruptedMessage(firstError: string | undefined): string {
  if (firstError?.startsWith(INTERRUPTED_PREFIX)) return firstError;
  return `${INTERRUPTED_PREFIX}${firstError ?? "the run ended before this test finished"}`;
}
