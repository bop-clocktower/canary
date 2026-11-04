/**
 * Arguments and environment for `canary testtracker push-perf` (#1580).
 *
 * Every field is checked against TestTracker's own rules for the perf-reports
 * body, so a typo is a usage error (exit 2), not a 400 that reads as a failed
 * push. Split from testtracker-perf.ts so the command module stays wiring only.
 */
import { randomUUID } from 'node:crypto';
import { envVar } from './config.js';

/** The arguments cannot run a push; the command prints its usage and exits 2. */
export class PerfUsageError extends Error {}

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

// TestTracker's rules for these body fields.
const SUITE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const isSuite = (s: string) => s.length <= 100 && SUITE_SLUG.test(s);
const isEnvironment = (e: string) => e.length <= 40 && ENVIRONMENT.test(e);
const isTime = (t: string | undefined) =>
  t === undefined || (ISO_WITH_OFFSET.test(t) && !Number.isNaN(Date.parse(t)));
const isRunRef = (r: string | undefined) => r === undefined || (r.trim() !== '' && r.length <= 200);

function isUrl(u: string): boolean {
  if (!u) return true;
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new PerfUsageError(`${what} is required.`);
  return value;
}

function refuseUnless(ok: boolean, message: string): void {
  if (!ok) throw new PerfUsageError(message);
}

/** `GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT` in CI, so a re-run attempt is its own report; else a fresh local id. */
function defaultRunRef(env: NodeJS.ProcessEnv): string {
  const id = env.GITHUB_RUN_ID;
  if (!id) return `local-${randomUUID()}`;
  return env.GITHUB_RUN_ATTEMPT ? `${id}-${env.GITHUB_RUN_ATTEMPT}` : id;
}

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

type Identity = Pick<PerfConfig, 'summary' | 'client' | 'suite' | 'environment'>;

/** The four fields every push needs, each checked as TestTracker would. */
function identity(a: PerfArgs, env: NodeJS.ProcessEnv): Identity {
  const summary = need(a.summary, '--k6-summary <file>');
  const client = need(a.client ?? env.CANARY_INGEST_CLIENT, '--client <slug> (or CANARY_INGEST_CLIENT)');
  // No CANARY_INGEST_SUITE fallback: a job that also runs a JUnit push sets it
  // to a functional suite, and a perf run filed there would be accepted.
  const suite = need(a.suite, '--suite <slug>');
  const environment = need(a.env ?? envVar(env, 'environment'), '--env <env> (or CANARY_INGEST_ENVIRONMENT)');
  refuseUnless(client.length <= 100, '--client is longer than 100 characters.');
  refuseUnless(isSuite(suite), `--suite "${suite}" is not a suite slug (lower-case words joined by single hyphens).`);
  refuseUnless(
    isEnvironment(environment),
    `--env "${environment}" is not an environment name (lower-case, e.g. dev, uat, prod).`,
  );
  return { summary, client, suite, environment };
}

/** Where to push, from the JUnit push's env names. Not needed for `--dry-run`. */
function target(dryRun: boolean, env: NodeJS.ProcessEnv): Pick<PerfConfig, 'url' | 'token'> {
  const url = envVar(env, 'url') ?? '';
  const token = envVar(env, 'token') ?? '';
  refuseUnless(
    dryRun || (url !== '' && token !== ''),
    'pushing needs CANARY_INGEST_URL and CANARY_INGEST_TOKEN (or use --dry-run).',
  );
  refuseUnless(isUrl(url), `CANARY_INGEST_URL "${url}" is not a URL.`);
  return { url, token };
}

export function configurePerf(args: readonly string[], env: NodeJS.ProcessEnv): PerfConfig {
  const a = parsePerfArgs(args);
  const id = identity(a, env);
  refuseUnless(isTime(a.generatedAt), '--generated-at must be an ISO-8601 time with Z or an offset.');
  refuseUnless(isRunRef(a.runRef), '--run-ref must be 1 to 200 characters.');
  const runRef = a.runRef ?? defaultRunRef(env);
  return { ...id, runRef, generatedAt: a.generatedAt, dryRun: a.dryRun, ...target(a.dryRun, env) };
}
