// Ingest reporter: options, env resolution and area mapping.

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
export function envVar(
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
const GLOB_TOKENS: Record<string, string> = { "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" };

function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (t) => GLOB_TOKENS[t] ?? `\\${t}`);
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
