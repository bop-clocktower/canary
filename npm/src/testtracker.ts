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
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXIT_ABSTAINED } from './gate-result.js';
import {
  envVar,
  resolveArea,
  resolveConfig,
} from './reporters/ingest/config.js';
import type { ResolvedConfig } from './reporters/ingest/config.js';
import { relativeFile } from './reporters/ingest/describe.js';
import { isJunitXml, readJunitCases } from './reporters/ingest/junit.js';
import {
  buildPayload,
  dedupeByFullTitle,
  fitPayload,
  runTiming,
} from './reporters/ingest/payload.js';
import type {
  CollectedEntry,
  ResultEntry,
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

const VALUE_FLAGS = new Set(['--suite', '--workflow']);

/** `--junit a.xml b.xml` takes every following non-flag; repeats accumulate. */
function parsePushArgs(args: readonly string[]): PushArgs {
  const parsed: PushArgs = { junit: [], collected: true, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    if (flag === '--junit') {
      const files = inline !== undefined ? [inline] : [];
      while (
        inline === undefined &&
        args[i + 1] !== undefined &&
        !args[i + 1].startsWith('--')
      )
        files.push(args[++i]);
      if (!files.length || files.some((f) => !f))
        throw new UsageError('--junit needs at least one file.');
      parsed.junit.push(...files);
    } else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('--'))
        throw new UsageError(`${flag} needs a value.`);
      parsed[flag === '--suite' ? 'suite' : 'workflow'] = value;
    } else if (flag === '--no-collected') parsed.collected = false;
    else if (flag === '--dry-run') parsed.dryRun = true;
    else throw new UsageError(`unknown option "${args[i]}".`);
  }
  if (!parsed.junit.length)
    throw new UsageError('--junit <file…> is required.');
  return parsed;
}

/** One report's rows, or the reason it cannot be pushed. */
interface ReadReport {
  file: string;
  rows: ResultEntry[];
  numbered: number;
  started?: number;
  seconds?: number;
}

class RefusedError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function readReport(file: string, cfg: ResolvedConfig): ReadReport {
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new RefusedError(`cannot read ${file} (${errText(err)}).`, 1);
  }
  if (!isJunitXml(xml))
    throw new RefusedError(`${file} is not a JUnit XML report.`, 1);
  const { cases, numbered } = readJunitCases(xml);
  // Where a row came from when the report names no file (node, Newman, Maestro).
  const reportPath = path.relative(process.cwd(), path.resolve(file)) || file;
  const rows = cases.map(({ title, file: testFile, ...rest }): ResultEntry => {
    const test_file = testFile
      ? relativeFile(testFile, cfg.testFilePrefix)
      : reportPath;
    const area = resolveArea([], test_file, cfg.areaMap);
    return { full_title: title, test_file, ...rest, ...(area ? { area } : {}) };
  });
  return { file, rows, numbered, ...timingOf(xml) };
}

/** The first suite timestamp (UTC when zoneless) and the root's `time`. */
function timingOf(xml: string): { started?: number; seconds?: number } {
  const stamp = /<testsuites?\b[^>]*?\btimestamp\s*=\s*["']([^"']+)["']/.exec(
    xml,
  )?.[1];
  const zoned =
    stamp && (/(?:Z|[+-]\d\d:?\d\d)$/.test(stamp) ? stamp : `${stamp}Z`);
  const started = zoned ? Date.parse(zoned) : NaN;
  const seconds = Number(
    /<testsuites?\b[^>]*?\btime\s*=\s*["']([^"']+)["']/.exec(xml)?.[1],
  );
  return {
    ...(Number.isFinite(started) ? { started } : {}),
    ...(Number.isFinite(seconds) ? { seconds } : {}),
  };
}

/** Earliest start across reports; the longest report decides the end. */
function timingAcross(reports: ReadReport[], now: number) {
  const starts = reports
    .map((r) => r.started)
    .filter((n): n is number => n !== undefined);
  if (!starts.length) return runTiming(undefined, now, now);
  const seconds = Math.max(0, ...reports.map((r) => r.seconds ?? 0));
  return runTiming(
    { startTime: new Date(Math.min(...starts)), duration: seconds * 1000 },
    now,
    now,
  );
}

/** Same title in two reports is one row there too (dedupe), tags merged. */
function catalog(rows: ResultEntry[]): CollectedEntry[] {
  const byTitle = new Map<string, CollectedEntry>();
  for (const { full_title, test_file, tags, area } of rows) {
    const prior = byTitle.get(full_title);
    byTitle.set(full_title, {
      full_title,
      test_file,
      tags: [...new Set([...(prior?.tags ?? []), ...tags])],
      ...(area ? { area } : {}),
    });
  }
  return [...byTitle.values()];
}

function denominatorLine(
  reports: ReadReport[],
  results: ResultEntry[],
): string {
  const read = reports.reduce((n, r) => n + r.rows.length, 0);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const failed = count('failed') + count('timed_out');
  const lines = [
    `canary testtracker: read ${read} testcases from ${reports.length} JUnit report${reports.length === 1 ? '' : 's'}; ` +
      `${results.length} results: ${count('passed')} passed, ${failed} failed, ${count('flaky')} flaky, ${count('skipped')} skipped.`,
  ];
  if (read !== results.length) {
    lines.push(
      `  ${read - results.length} testcase(s) shared a title across reports and were merged (worst status wins).`,
    );
  }
  for (const r of reports.filter((x) => x.numbered)) {
    lines.push(
      `  ${r.numbered} testcase(s) in ${r.file} share a title and name no file; numbered " [2]", " [3]" in report order, so their identity follows that order.`,
    );
  }
  return `${lines.join('\n')}\n`;
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
  try {
    opts = parsePushArgs(args);
    cfg = resolveConfig(
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
  } catch (e) {
    err.write(`canary testtracker: ${errText(e)}\n\n${USAGE}`);
    return 2;
  }
  for (const w of cfg.configWarnings) warn(w, env);

  let reports: ReadReport[];
  try {
    reports = opts.junit.map((f) => readReport(f, cfg));
  } catch (e) {
    const code = e instanceof RefusedError ? e.code : 1;
    err.write(`canary testtracker: ${errText(e)} Nothing was pushed.\n`);
    return code;
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
    timingAcross(reports, Date.now()),
    env,
    undefined,
    {
      collected: cfg.collected ? catalog(rows) : null,
    },
  );
  out.write(denominatorLine(reports, dedupeByFullTitle(rows)));
  if (opts.dryRun) {
    out.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  const fitted = fitPayload(payload);
  for (const w of fitted.warnings) warn(w, env);
  return (await push(cfg, fitted.payload)) ? 0 : 1;
}

/** `canary testtracker <subcommand>`; returns the process exit code. */
export async function runTesttracker(
  argv: readonly string[],
  deps: TesttrackerDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  if (
    sub === undefined ||
    ['--help', '-h', 'help'].includes(sub) ||
    rest.some((a) => a === '--help' || a === '-h')
  ) {
    (sub === undefined
      ? (deps.err ?? process.stderr)
      : (deps.out ?? process.stdout)
    ).write(USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (sub !== 'push') {
    (deps.err ?? process.stderr).write(
      `canary testtracker: unknown subcommand '${sub}'.\n\n${USAGE}`,
    );
    return 2;
  }
  return runPush(rest, deps);
}
