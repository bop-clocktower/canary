/**
 * `canary testtracker push-perf --k6-summary <file> --client <slug>
 * --suite <slug> --env <env>` (#1580).
 *
 * Pushes one k6 run to TestTracker's `POST /api/v1/tenants/{client}/perf-reports`
 * with the client's `tt_` ingest token. Reads `handleSummary` data only and
 * sends what k6 said; TestTracker derives every trend key and the verdict.
 * Shares the JUnit push's env names and retry loop.
 *
 * Exit codes: 0 pushed (or printed, `--dry-run`); 1 unreadable summary,
 * too many objectives or too large a body (nothing sent), or not ingested;
 * 2 usage; 3 abstained: no metrics, or 0 requests and 0 iterations
 * (nothing sent).
 */
import { EXIT_ABSTAINED } from './gate-result.js';
import {
  k6Abstention,
  k6Denominator,
  k6Headline,
  k6Objectives,
  readK6Summary,
  K6SummaryError,
} from './reporters/perf/k6-summary.js';
import type { PerfHeadline, PerfObjective } from './reporters/perf/k6-summary.js';
import { configurePerf, PerfUsageError } from './reporters/perf/perf-args.js';
import type { PerfConfig } from './reporters/perf/perf-args.js';
import { errText, log, postWithRetry, warn } from './reporters/ingest/transport.js';

const PERF_USAGE = `usage: canary testtracker push-perf --k6-summary <file> --client <slug> --suite <slug> --env <env> [options]

Push one k6 run to TestTracker's perf-reports route with the client's
tt_ ingest token. Reads handleSummary data: in your script,
  export function handleSummary(data) { return { 'perf-summary.json': JSON.stringify(data) }; }

  --k6-summary <file>  the handleSummary JSON (not --summary-export output)
  --client <slug>      TestTracker client slug (else CANARY_INGEST_CLIENT);
                       must be the client the token belongs to
  --suite <slug>       the perf suite, lower-kebab (no env fallback)
  --env <env>          environment, e.g. dev, uat, prod (else
                       CANARY_INGEST_ENVIRONMENT); never compared across
  --run-ref <ref>      idempotency key (default GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT
                       in CI, else local-<uuid>)
  --generated-at <iso> when the run ended (default: the file's mtime)
  --dry-run            print the body instead of pushing
  -h, --help           show this help

Environment: CANARY_INGEST_URL (its origin is used) and CANARY_INGEST_TOKEN.

Exit: 0 pushed, 1 unreadable summary or not ingested (nothing stored),
2 usage, 3 abstained (no metrics, or 0 requests and 0 iterations; nothing pushed).
`;

const PREFIX = 'canary testtracker push-perf:';

/** TestTracker's per-report objective cap and the route's JSON body limit ("2mb"). */
const MAX_OBJECTIVES = 2000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

interface Writer {
  write(s: string): unknown;
}

/** Structurally the same as `TesttrackerDeps`; declared here so the two modules do not import each other. */
export interface PerfDeps {
  out?: Writer;
  err?: Writer;
  env?: NodeJS.ProcessEnv;
  /** Waits between push retries; [1000, 4000] when absent. */
  retryDelaysMs?: number[];
}

/** The perf-report body TestTracker accepts (camelCase; optional keys omitted, never null). */
export interface PerfReportBody {
  suite: string;
  environment: string;
  runRef: string;
  generatedAt: string;
  gitSha?: string;
  gitBranch?: string;
  runUrl?: string;
  headline: PerfHeadline;
  objectives: PerfObjective[];
}

function provenance(env: NodeJS.ProcessEnv): Pick<PerfReportBody, 'gitSha' | 'gitBranch' | 'runUrl'> {
  const p: Pick<PerfReportBody, 'gitSha' | 'gitBranch' | 'runUrl'> = {};
  if (env.GITHUB_SHA) p.gitSha = env.GITHUB_SHA.slice(0, 64);
  if (env.GITHUB_REF_NAME) p.gitBranch = env.GITHUB_REF_NAME.slice(0, 255);
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env;
  // TestTracker accepts https run links only.
  if (server?.startsWith('https://') && repo && id) p.runUrl = `${server}/${repo}/actions/runs/${id}`;
  return p;
}

function buildPerfBody(
  cfg: PerfConfig,
  headline: PerfHeadline,
  objectives: PerfObjective[],
  mtime: Date,
  env: NodeJS.ProcessEnv,
): PerfReportBody {
  return {
    suite: cfg.suite,
    environment: cfg.environment,
    runRef: cfg.runRef,
    generatedAt: new Date(cfg.generatedAt ?? mtime).toISOString(),
    ...provenance(env),
    headline,
    objectives,
  };
}

const perfPath = (client: string) => `/api/v1/tenants/${encodeURIComponent(client)}/perf-reports`;

const HINTS: Record<number, string> = {
  400: "the body failed TestTracker's schema; is canary older than the server?",
  401: 'the token is unknown, revoked or expired, or not a tt_ ingest token',
  403: 'the token lacks the ingest:runs scope',
  404: "--client is not this token's client (or the server has no perf-reports route yet)",
  413: "the body is over the route's 2 MB limit",
  422: 'TestTracker refused the content',
};

/** A 2xx: true only when TestTracker names the report it stored (or already had). */
async function confirmStored(resp: Response, body: PerfReportBody, env: NodeJS.ProcessEnv): Promise<boolean> {
  const data = (await resp.json().catch(() => ({}))) as { reportId?: unknown; duplicate?: unknown };
  if (typeof data.reportId !== 'number') {
    // "Cannot verify" is a finding, not a pass.
    warn(`TestTracker answered ${resp.status} without a reportId, so this push cannot confirm the perf report was stored.`, env);
    return false;
  }
  log(
    data.duplicate === true
      ? `perf report ${data.reportId} already ingested (duplicate re-push of run ${body.runRef}); this push stored nothing.`
      : `perf report ${data.reportId} ingested.`,
  );
  return true;
}

/** Anything but a 2xx, after the retry loop has given up or declined to retry. */
async function explainFailure(resp: Response | undefined, error: unknown, attempts: number, env: NodeJS.ProcessEnv): Promise<void> {
  if (!resp) {
    warn(`perf report not ingested after ${attempts} attempts (${errText(error)}).`, env);
    return;
  }
  const text = (await resp.text().catch(() => '')).slice(0, 300);
  if (resp.status >= 500 || resp.status === 429) {
    warn(`perf report not ingested after ${attempts} attempts (${resp.status} ${text}).`, env);
    return;
  }
  const hint = HINTS[resp.status] ?? 'a client error';
  warn(`perf report rejected (${resp.status}: ${hint}): ${text}. Not retried; nothing was stored.`, env);
}

/** POSTs the report; true only when TestTracker confirms a stored (or already stored) report. */
async function sendPerf(cfg: PerfConfig, body: PerfReportBody, delaysMs: number[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const { resp, error, attempts } = await postWithRetry(
    `${new URL(cfg.url).origin}${perfPath(cfg.client)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
    },
    delaysMs,
  );
  if (resp?.ok) return confirmStored(resp, body, env);
  await explainFailure(resp, error, attempts, env);
  return false;
}

/** The config, or exit 2 after printing why and the usage. */
function configureOrExplain(args: readonly string[], env: NodeJS.ProcessEnv, err: Writer): PerfConfig | number {
  try {
    return configurePerf(args, env);
  } catch (e) {
    if (!(e instanceof PerfUsageError)) throw e;
    err.write(`${PREFIX} ${e.message}\n\n${PERF_USAGE}`);
    return 2;
  }
}

/** The summary, or null after saying why it cannot be read (the command exits 1). */
function readOrExplain(file: string, err: Writer): ReturnType<typeof readK6Summary> | null {
  try {
    return readK6Summary(file);
  } catch (e) {
    if (!(e instanceof K6SummaryError)) throw e;
    err.write(`${PREFIX} ${e.message} Nothing was pushed.\n`);
    return null;
  }
}

/**
 * The exit code when this report must not be sent, else null. Each refusal
 * sends nothing: a run that measured nothing would read as a smaller, greener
 * history, and dropping objectives to fit would push a run judged on fewer
 * bars than it had.
 */
function refusal(summaryFile: string, abstain: string | null, body: PerfReportBody, err: Writer): number | null {
  if (abstain) {
    err.write(`${PREFIX} abstained: ${abstain} in ${summaryFile}, so nothing was pushed.\n`);
    return EXIT_ABSTAINED;
  }
  if (body.objectives.length > MAX_OBJECTIVES) {
    err.write(
      `${PREFIX} ${summaryFile} holds ${body.objectives.length} thresholds; TestTracker takes at most ` +
        '2,000 per report. Dropping some would push a run judged on fewer bars than it had. Nothing was pushed.\n',
    );
    return 1;
  }
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > MAX_BODY_BYTES) {
    err.write(`${PREFIX} the report is ${bytes} bytes, over TestTracker's 2 MiB limit for this route. Nothing was pushed.\n`);
    return 1;
  }
  return null;
}

function io(deps: PerfDeps) {
  return {
    out: deps.out ?? process.stdout,
    err: deps.err ?? process.stderr,
    env: deps.env ?? process.env,
    delaysMs: deps.retryDelaysMs ?? [1000, 4000],
  };
}

export async function runPushPerf(args: readonly string[], deps: PerfDeps): Promise<number> {
  const { out, err, env, delaysMs } = io(deps);
  if (args.some((x) => x === '--help' || x === '-h')) {
    out.write(PERF_USAGE);
    return 0;
  }
  const cfg = configureOrExplain(args, env, err);
  if (typeof cfg === 'number') return cfg;
  const read = readOrExplain(cfg.summary, err);
  if (!read) return 1;
  const headline = k6Headline(read.summary);
  const objectives = k6Objectives(read.summary);
  const body = buildPerfBody(cfg, headline, objectives, read.mtime, env);
  const refused = refusal(cfg.summary, k6Abstention(read.summary, headline), body, err);
  if (refused !== null) return refused;
  out.write(k6Denominator(cfg.summary, objectives));
  if (cfg.dryRun) {
    out.write(`POST ${perfPath(cfg.client)}\n${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }
  return (await sendPerf(cfg, body, delaysMs, env)) ? 0 : 1;
}
