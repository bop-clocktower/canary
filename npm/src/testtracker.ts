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
 * not JUnit, the push was not ingested, or a strict budget refused a lossy fit
 * (#1355); 2 usage; 3 abstained — a report held zero testcases, so nothing was
 * pushed (#508 D4).
 */
import { EXIT_ABSTAINED } from './gate-result.js';
import { budgetRefusal, isCi } from './reporters/ingest/budget.js';
import {
  envVar,
  resolveArea,
  resolveConfig,
} from './reporters/ingest/config.js';
import { resolveFeatures } from './reporters/ingest/entry/features.js';
import type { ResolvedConfig } from './reporters/ingest/config.js';
import { relativeFile } from './reporters/ingest/describe.js';
import {
  junitCatalog,
  junitDenominator,
  junitRunTiming,
  readJunitReport,
} from './reporters/ingest/junit-run.js';
import type { JunitReport, Locate } from './reporters/ingest/junit-run.js';
import {
  buildPayload,
  dedupeByFullTitle,
  fitPayload,
} from './reporters/ingest/payload.js';
import { quarantineResults } from './reporters/ingest/quarantine.js';
import { errText, push, warn } from './reporters/ingest/transport.js';
import { runPushPerf } from './testtracker-perf.js';
import {
  isEnvFeatureMapWarning,
  readFeaturesMap,
} from './testtracker-features.js';
import { USAGE } from './testtracker-usage.js';

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


interface PushArgs {
  junit: string[];
  suite?: string;
  workflow?: string;
  collected: boolean;
  dryRun: boolean;
  /** Unset = the CI default (`isCi`); a flag always wins. */
  strictBudget?: boolean;
  quarantineLedger?: string;
  level?: string;
  featuresMap?: string;
}

class UsageError extends Error {}

/** Every flag but `--junit`: whether it takes a value, and where it goes. */
const FLAGS: Record<
  string,
  { takes: boolean; set: (p: PushArgs, value: string) => void }
> = {
  '--suite': { takes: true, set: (p, v) => (p.suite = v) },
  '--workflow': { takes: true, set: (p, v) => (p.workflow = v) },
  '--no-collected': { takes: false, set: (p) => (p.collected = false) },
  '--dry-run': { takes: false, set: (p) => (p.dryRun = true) },
  '--strict-budget': { takes: false, set: (p) => (p.strictBudget = true) },
  '--no-strict-budget': { takes: false, set: (p) => (p.strictBudget = false) },
  '--quarantine-ledger': { takes: true, set: (p, v) => (p.quarantineLedger = v) },
  '--level': { takes: true, set: (p, v) => (p.level = v) },
  '--features-map': { takes: true, set: (p, v) => (p.featuresMap = v) },
};


/**
 * `--junit=a.xml` is one file; `--junit a.xml b.xml` takes every following
 * non-flag. Returns the files and the index after them.
 */
function junitFiles(
  args: readonly string[],
  from: number,
  inline: string | undefined,
): { files: string[]; next: number } {
  const end = args.findIndex((a, i) => i >= from && a.startsWith('--'));
  const files =
    inline !== undefined
      ? [inline]
      : args.slice(from, end === -1 ? args.length : end);
  if (!files.length || files.some((f) => !f))
    throw new UsageError('--junit needs at least one file.');
  return { files, next: inline !== undefined ? from : from + files.length };
}

function flagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--'))
    throw new UsageError(`${flag} needs a value.`);
  return value;
}

/** `--junit` may repeat and its files accumulate; other flags are single. */
function parsePushArgs(args: readonly string[]): PushArgs {
  const parsed: PushArgs = { junit: [], collected: true, dryRun: false };
  let i = 0;
  while (i < args.length) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    i += 1;
    if (flag === '--junit') {
      const { files, next } = junitFiles(args, i, inline);
      parsed.junit.push(...files);
      i = next;
      continue;
    }
    const spec = FLAGS[flag];
    if (!spec) throw new UsageError(`unknown option "${args[i - 1]}".`);
    if (!spec.takes) spec.set(parsed, '');
    else if (inline !== undefined) spec.set(parsed, flagValue(flag, inline));
    else spec.set(parsed, flagValue(flag, args[i++]));
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
      quarantineLedger: opts.quarantineLedger,
      ...(opts.level ? { level: opts.level } : {}),
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

/** The reporter's file prefix and area map (#1183), applied to JUnit rows. */
function locator(cfg: ResolvedConfig): Locate {
  return (testFile, reportPath) => {
    const test_file = testFile
      ? relativeFile(testFile, cfg.testFilePrefix)
      : reportPath;
    const area = resolveArea([], test_file, cfg.areaMap);
    const features = resolveFeatures([], test_file, cfg.featureMap);
    return {
      test_file,
      ...(area ? { area } : {}),
      ...(features ? { features } : {}),
    };
  };
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
  for (const w of cfg.configWarnings)
    if (!(opts.featuresMap && isEnvFeatureMapWarning(w))) warn(w, env);
  try {
    if (opts.featuresMap) {
      const globWarnings: string[] = [];
      cfg = {
        ...cfg,
        featureMap: readFeaturesMap(opts.featuresMap, globWarnings),
      };
      for (const w of globWarnings) warn(w, env);
    }
    reports = opts.junit.map((f) => readJunitReport(f, locator(cfg)));
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
  let results = rows;
  try {
    const q = await quarantineResults(cfg.quarantineLedger, rows);
    results = q.results;
    if (q.summary) out.write(`${q.summary}\n`);
  } catch (e) {
    err.write(`canary testtracker: ${errText(e)} Nothing was pushed.\n`);
    return 1;
  }
  const payload = buildPayload(
    results,
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
  const strict = opts.strictBudget ?? isCi(env);
  const refusal = strict
    ? budgetRefusal(
        fitted,
        opts.strictBudget ? '--strict-budget' : 'the default when CI is set',
      )
    : null;
  if (refusal) {
    err.write(refusal);
    return 1;
  }
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
  if (sub === 'push-perf') return runPushPerf(rest, deps);
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
