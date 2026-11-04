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
import { envVar } from './reporters/ingest/config.js';
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

export async function runPushPerf(args: readonly string[], deps: TesttrackerDeps): Promise<number> {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  if (args.some((x) => x === '--help' || x === '-h')) {
    out.write(PERF_USAGE);
    return 0;
  }
  try {
    configurePerf(args, deps.env ?? process.env);
  } catch (e) {
    if (!(e instanceof PerfUsageError)) throw e;
    err.write(`canary testtracker push-perf: ${e.message}\n\n${PERF_USAGE}`);
    return 2;
  }
  return 0; // Tasks 10–12 fill this in.
}
