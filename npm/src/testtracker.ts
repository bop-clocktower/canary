/**
 * `canary testtracker push --junit <file…> --suite <name>` (#1320).
 *
 * The Playwright ingest reporter is the only TestTracker producer; vitest,
 * `node --test`, Newman and Maestro all write JUnit XML instead. This command
 * maps JUnit reports onto the same rows and sends them through the reporter's
 * own config, payload builder, size budget and push — one wire contract, one
 * retry policy — and keeps its guarantees: a stated denominator, no push for a
 * run where nothing ran, and the area handling from #1183.
 *
 * Exit codes: 0 pushed (or printed, `--dry-run`); 1 a report was unreadable or
 * not JUnit, or the push was not ingested; 2 usage; 3 abstained — a report
 * held zero testcases, so nothing was pushed (#508 D4).
 */
import { EXIT_ABSTAINED } from './gate-result.js';
import { envVar, resolveConfig } from './reporters/ingest/config.js';
import type { ResolvedConfig } from './reporters/ingest/config.js';
import {
  junitCatalog,
  junitDenominator,
  junitRunTiming,
  readJunitReport,
} from './reporters/ingest/junit-run.js';
import type { JunitReport } from './reporters/ingest/junit-run.js';
import {
  buildPayload,
  dedupeByFullTitle,
  fitPayload,
} from './reporters/ingest/payload.js';
import { errText, push, warn } from './reporters/ingest/transport.js';

interface Writer {
  write(s: string): unknown;
}

export interface TesttrackerDeps {
  out?: Writer;
  err?: Writer;
  env?: NodeJS.ProcessEnv;
  /** Waits between push retries; the reporter's default when absent. */
  retryDelaysMs?: number[];
}

const USAGE = `usage: canary testtracker push --junit <file…> --suite <name> [options]

Push JUnit XML test reports to a TestTracker /api/ingest endpoint, with the
same payload, retry and size budget as the Playwright reporter.

  --junit <file…>    one or more JUnit XML reports (repeatable)
  --suite <name>     dashboard suite (else CANARY_INGEST_SUITE)
  --workflow <label> workflow label (else CANARY_INGEST_WORKFLOW, default "junit")
  --no-collected     do not send the catalog; use when the reports are a
                     subset of the suite (a shard, a name filter)
  --dry-run          print the payload instead of pushing
  -h, --help         show this help

Environment: CANARY_INGEST_URL and CANARY_INGEST_TOKEN (required to push),
CANARY_INGEST_ENVIRONMENT, CANARY_INGEST_AREA_MAP, CANARY_INGEST_TEST_FILE_PREFIX.

Producing a report:
  vitest     vitest run --reporter=junit --outputFile=junit.xml
  node       node --test --test-reporter=junit --test-reporter-destination=junit.xml
  newman     newman run collection.json -r junit --reporter-junit-export junit.xml
  maestro    maestro test flows/ --format junit --output junit.xml

Exit: 0 pushed, 1 unreadable report or push not ingested, 2 usage,
3 abstained (a report holds zero testcases; nothing pushed).
`;

interface PushArgs {
  junit: string[];
  suite?: string;
  workflow?: string;
  collected: boolean;
  dryRun: boolean;
}

class UsageError extends Error {}

/** Every flag but `--junit`; `value()` takes the flag's argument or throws. */
const FLAGS: Record<string, (p: PushArgs, value: () => string) => void> = {
  '--suite': (p, value) => (p.suite = value()),
  '--workflow': (p, value) => (p.workflow = value()),
  '--no-collected': (p) => (p.collected = false),
  '--dry-run': (p) => (p.dryRun = true),
};

/** The run of non-flag arguments starting at `from`. */
function leadingFiles(args: readonly string[], from: number): string[] {
  const end = args.findIndex((a, i) => i >= from && a.startsWith('--'));
  return args.slice(from, end === -1 ? args.length : end);
}

/** `--junit a.xml b.xml` takes every following non-flag; repeats accumulate. */
function parsePushArgs(args: readonly string[]): PushArgs {
  const parsed: PushArgs = { junit: [], collected: true, dryRun: false };
  let i = 0;
  while (i < args.length) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    i += 1;
    if (flag === '--junit') {
      const files = inline !== undefined ? [inline] : leadingFiles(args, i);
      if (inline === undefined) i += files.length;
      if (!files.length || files.some((f) => !f))
        throw new UsageError('--junit needs at least one file.');
      parsed.junit.push(...files);
      continue;
    }
    const handler = FLAGS[flag];
    if (!handler) throw new UsageError(`unknown option "${args[i - 1]}".`);
    handler(parsed, () => {
      const v = inline ?? args[i++];
      if (!v || v.startsWith('--'))
        throw new UsageError(`${flag} needs a value.`);
      return v;
    });
  }
  if (!parsed.junit.length)
    throw new UsageError('--junit <file…> is required.');
  return parsed;
}

/** Flags and env resolved into the reporter's own config, or a usage error. */
function configure(
  args: readonly string[],
  deps: TesttrackerDeps,
  env: NodeJS.ProcessEnv,
): { opts: PushArgs; cfg: ResolvedConfig } {
  const opts = parsePushArgs(args);
  const cfg = resolveConfig(
    {
      suite: opts.suite,
      workflow: opts.workflow ?? envVar(env, 'workflow') ?? 'junit',
      collected: opts.collected && envVar(env, 'collected') !== 'false',
      ...(deps.retryDelaysMs ? { retryDelaysMs: deps.retryDelaysMs } : {}),
    },
    env,
  );
  if (!opts.dryRun && (!cfg.url || !cfg.token)) {
    throw new UsageError(
      'pushing needs CANARY_INGEST_URL and CANARY_INGEST_TOKEN (or use --dry-run).',
    );
  }
  return { opts, cfg };
}

async function runPush(
  args: readonly string[],
  deps: TesttrackerDeps,
): Promise<number> {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  const env = deps.env ?? process.env;
  let opts: PushArgs;
  let cfg: ResolvedConfig;
  let reports: JunitReport[];
  try {
    ({ opts, cfg } = configure(args, deps, env));
  } catch (e) {
    err.write(`canary testtracker: ${errText(e)}\n\n${USAGE}`);
    return 2;
  }
  for (const w of cfg.configWarnings) warn(w, env);
  try {
    reports = opts.junit.map((f) => readJunitReport(f, cfg));
  } catch (e) {
    err.write(`canary testtracker: ${errText(e)} Nothing was pushed.\n`);
    return 1;
  }
  const empty = reports.filter((r) => r.rows.length === 0);
  if (empty.length) {
    // A report with no testcases is a runner that crashed or ran nothing; a
    // push without it would read as a smaller, greener suite.
    err.write(
      `canary testtracker: abstained — ${empty.map((r) => r.file).join(', ')} holds 0 testcases, so nothing was pushed.\n`,
    );
    return EXIT_ABSTAINED;
  }
  const rows = reports.flatMap((r) => r.rows);
  const payload = buildPayload(
    rows,
    cfg,
    junitRunTiming(reports, Date.now()),
    env,
    undefined,
    { collected: cfg.collected ? junitCatalog(rows) : null },
  );
  out.write(junitDenominator(reports, dedupeByFullTitle(rows)));
  if (opts.dryRun) {
    out.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  const fitted = fitPayload(payload);
  for (const w of fitted.warnings) warn(w, env);
  return (await push(cfg, fitted.payload)) ? 0 : 1;
}

const isHelp = (a: string) => a === '--help' || a === '-h' || a === 'help';

/** `canary testtracker <subcommand>`; returns the process exit code. */
export async function runTesttracker(
  argv: readonly string[],
  deps: TesttrackerDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  const err = deps.err ?? process.stderr;
  if (sub === undefined) {
    err.write(USAGE);
    return 2;
  }
  if (isHelp(sub) || rest.some(isHelp)) {
    (deps.out ?? process.stdout).write(USAGE);
    return 0;
  }
  if (sub !== 'push') {
    err.write(`canary testtracker: unknown subcommand '${sub}'.\n\n${USAGE}`);
    return 2;
  }
  return runPush(rest, deps);
}
