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
import { randomUUID } from 'node:crypto';
import { EXIT_ABSTAINED } from './gate-result.js';
import { envVar } from './reporters/ingest/config.js';
import {
  k6Abstention,
  k6Denominator,
  k6Headline,
  k6Objectives,
  readK6Summary,
  K6SummaryError,
} from './reporters/ingest/k6-summary.js';
import type { PerfHeadline, PerfObjective } from './reporters/ingest/k6-summary.js';
import { postWithRetry } from './reporters/ingest/transport.js';
import type { TesttrackerDeps } from './testtracker.js';

export const PERF_USAGE = `usage: canary testtracker push-perf --k6-summary <file> --client <slug> --suite <slug> --env <env> [options]

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

class PerfUsageError extends Error {}

interface PerfArgs {
  summary?: string;
  client?: string;
  suite?: string;
  env?: string;
  runRef?: string;
  generatedAt?: string;
  dryRun: boolean;
}

const VALUE_FLAGS: Record<string, Exclude<keyof PerfArgs, 'dryRun'>> = {
  '--k6-summary': 'summary',
  '--client': 'client',
  '--suite': 'suite',
  '--env': 'env',
  '--run-ref': 'runRef',
  '--generated-at': 'generatedAt',
};

function parsePerfArgs(args: readonly string[]): PerfArgs {
  const parsed: PerfArgs = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    if (flag === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    const key = VALUE_FLAGS[flag];
    if (!key) throw new PerfUsageError(`unknown option "${args[i]}".`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new PerfUsageError(`${flag} needs a value.`);
    parsed[key] = value;
  }
  return parsed;
}

// TestTracker's own rules for these fields, checked here so a typo is a usage
// error, not a 400 that reads as a failed push.
const SUITE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** TestTracker's per-report objective cap and the route's JSON body limit ("2mb"). */
const MAX_OBJECTIVES = 2000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface PerfConfig {
  summary: string;
  client: string;
  suite: string;
  environment: string;
  runRef: string;
  generatedAt?: string;
  dryRun: boolean;
  url: string;
  token: string;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new PerfUsageError(`${what} is required.`);
  return value;
}

export function configurePerf(args: readonly string[], env: NodeJS.ProcessEnv): PerfConfig {
  const a = parsePerfArgs(args);
  const summary = need(a.summary, '--k6-summary <file>');
  const client = need(a.client ?? env.CANARY_INGEST_CLIENT, '--client <slug> (or CANARY_INGEST_CLIENT)');
  // No CANARY_INGEST_SUITE fallback: a job that also runs a JUnit push sets it
  // to a functional suite, and a perf run filed there would be accepted.
  const suite = need(a.suite, '--suite <slug>');
  const environment = need(a.env ?? envVar(env, 'environment'), '--env <env> (or CANARY_INGEST_ENVIRONMENT)');
  if (client.length > 100) throw new PerfUsageError('--client is longer than 100 characters.');
  if (suite.length > 100 || !SUITE_SLUG.test(suite)) {
    throw new PerfUsageError(`--suite "${suite}" is not a suite slug (lower-case words joined by single hyphens).`);
  }
  if (environment.length > 40 || !ENVIRONMENT.test(environment)) {
    throw new PerfUsageError(`--env "${environment}" is not an environment name (lower-case, e.g. dev, uat, prod).`);
  }
  if (a.generatedAt !== undefined && (!ISO_WITH_OFFSET.test(a.generatedAt) || Number.isNaN(Date.parse(a.generatedAt)))) {
    throw new PerfUsageError('--generated-at must be an ISO-8601 time with Z or an offset.');
  }
  if (a.runRef !== undefined && (a.runRef.trim() === '' || a.runRef.length > 200)) {
    throw new PerfUsageError('--run-ref must be 1 to 200 characters.');
  }
  const url = envVar(env, 'url') ?? '';
  const token = envVar(env, 'token') ?? '';
  if (!a.dryRun && (!url || !token)) {
    throw new PerfUsageError('pushing needs CANARY_INGEST_URL and CANARY_INGEST_TOKEN (or use --dry-run).');
  }
  if (url) {
    try {
      new URL(url);
    } catch {
      throw new PerfUsageError(`CANARY_INGEST_URL "${url}" is not a URL.`);
    }
  }
  const runId = env.GITHUB_RUN_ID;
  const runRef =
    a.runRef ?? (runId ? (env.GITHUB_RUN_ATTEMPT ? `${runId}-${env.GITHUB_RUN_ATTEMPT}` : runId) : `local-${randomUUID()}`);
  return { summary, client, suite, environment, runRef, generatedAt: a.generatedAt, dryRun: a.dryRun, url, token };
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

export function buildPerfBody(
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

export const perfPath = (client: string) => `/api/v1/tenants/${encodeURIComponent(client)}/perf-reports`;

export async function runPushPerf(args: readonly string[], deps: TesttrackerDeps): Promise<number> {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  if (args.some((x) => x === '--help' || x === '-h')) {
    out.write(PERF_USAGE);
    return 0;
  }
  const env = deps.env ?? process.env;
  let cfg: PerfConfig;
  try {
    cfg = configurePerf(args, env);
  } catch (e) {
    if (!(e instanceof PerfUsageError)) throw e;
    err.write(`canary testtracker push-perf: ${e.message}\n\n${PERF_USAGE}`);
    return 2;
  }
  let read: ReturnType<typeof readK6Summary>;
  try {
    read = readK6Summary(cfg.summary);
  } catch (e) {
    if (!(e instanceof K6SummaryError)) throw e;
    err.write(`canary testtracker push-perf: ${e.message} Nothing was pushed.\n`);
    return 1;
  }
  const headline = k6Headline(read.summary);
  const objectives = k6Objectives(read.summary);
  const abstain = k6Abstention(read.summary, headline);
  if (abstain) {
    // A run that measured nothing would read as a smaller, greener history.
    err.write(`canary testtracker push-perf: abstained: ${abstain} in ${cfg.summary}, so nothing was pushed.\n`);
    return EXIT_ABSTAINED;
  }
  if (objectives.length > MAX_OBJECTIVES) {
    err.write(
      `canary testtracker push-perf: ${cfg.summary} holds ${objectives.length} thresholds; TestTracker takes at most ` +
        '2,000 per report. Dropping some would push a run judged on fewer bars than it had. Nothing was pushed.\n',
    );
    return 1;
  }
  const body = buildPerfBody(cfg, headline, objectives, read.mtime, env);
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > MAX_BODY_BYTES) {
    err.write(
      `canary testtracker push-perf: the report is ${bytes} bytes, over TestTracker's 2 MiB limit for this route. Nothing was pushed.\n`,
    );
    return 1;
  }
  out.write(k6Denominator(cfg.summary, objectives));
  if (cfg.dryRun) {
    out.write(`POST ${perfPath(cfg.client)}\n${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }
  // A minimal send, so the wire tests can read the body; the outcome
  // handling replaces it in the next commit.
  await postWithRetry(
    `${new URL(cfg.url).origin}${perfPath(cfg.client)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
    },
    deps.retryDelaysMs ?? [1000, 4000],
  );
  return 0;
}
