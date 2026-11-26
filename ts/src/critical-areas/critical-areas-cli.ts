/**
 * `canary critical-areas` (#1529): writes `.canary/critical-areas.json`, which
 * canary-katana alarms against. See docs/guides/critical-areas.md.
 *
 * Exit codes follow the CLI-wide gate contract:
 *   - 0: the file was written.
 *   - 1: the file could not be written, or a default output would leave the
 *     repository through a symlinked .canary. Any existing file is left intact.
 *   - 2: an explicit --coverage report is missing or unparseable.
 *   - 3 (EXIT_ABSTAINED): nothing to rank, so NOTHING is written. An empty map
 *     would also overwrite a good one.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Command } from 'commander';

import { CliExitError, jsonIndent2 } from '../cli-common.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import {
  anchorIndex,
  readReportIndex,
} from '../guardian/diff-coverage/report-tier.js';
import type {
  FileCoverage,
  ReportIndex,
} from '../guardian/diff-coverage/types.js';
import type { MainDeps } from '../main-deps.js';
import { keepSymbols } from './declared-symbols.js';
import { readGitFacts, type GitFacts } from './git-signals.js';
import { countImporters } from './importers.js';
import { defaultOut, writeAtomically } from './output-file.js';
import {
  buildDocument,
  CHURN_WINDOW_DAYS,
  type FileSignals,
  type SignalSource,
} from './scoring.js';
import { showPath } from './show-path.js';

/** The conventional report names, first found wins (D11). */
const DISCOVERED_REPORTS = [
  'coverage/lcov.info',
  'lcov.info',
  'coverage/coverage.json',
  'coverage.json',
  'coverage.xml',
];

interface CriticalAreasOpts {
  root?: string;
  out?: string;
  coverage?: string;
}

interface CoverageRead {
  pctOf: (path: string) => number | null;
  source: SignalSource;
}

interface ParsedReport {
  path: string;
  index: ReportIndex;
}

const absentCoverage = (reason: string): CoverageRead => ({
  pctOf: () => null,
  source: { status: 'absent', reason },
});

/**
 * Hit lines over measured lines; a file with none measured is unknown. With no
 * declared set, recorded lines are not a denominator: a coverage-json carrying
 * only covered_lines would read 100%.
 */
function linePct(file: FileCoverage): number | null {
  const measured = file.coverable;
  if (measured === null || measured.size === 0) return null;
  const hit = [...measured].filter((l) => (file.hits[l] ?? 0) > 0).length;
  return Math.round((1000 * hit) / measured.size) / 10;
}

/** A typo'd flag must not quietly degrade (D12): exit 2 before anything else. */
function readExplicitReport(
  opts: CriticalAreasOpts,
  deps: MainDeps,
): ParsedReport | null {
  if (opts.coverage === undefined) return null;
  const path = resolve(deps.cwd(), opts.coverage);
  const { found, index } = readReportIndex(path);
  // git's top level is a realpath, so anchoring through a symlink would miss.
  if (index !== null) return { path: realpathSync(path), index };
  deps.err(
    found
      ? `--coverage ${path} could not be parsed.`
      : `--coverage ${path} does not exist.`,
  );
  throw new CliExitError(2);
}

function discoverReport(facts: GitFacts): CoverageRead | ParsedReport[] {
  const top = facts.top;
  const name = DISCOVERED_REPORTS.find((r) => existsSync(join(top, r)));
  if (name === undefined) return discoverPackageReports(facts);
  const path = join(top, name);
  const { index } = readReportIndex(path);
  return index === null
    ? absentCoverage(`${name} could not be parsed`)
    : [{ path, index }];
}

/**
 * With no root report, `<pkg>/coverage/lcov.info` beside each tracked
 * `package.json` -- where `npm test` writes it (#1751). On canary's own tree the
 * root lookup alone found nothing, so every area read "coverage not measured"
 * while `ts/coverage/lcov.info` matched 232 files. Every report found is read;
 * a package without a `package.json` is not searched.
 */
function discoverPackageReports(
  facts: GitFacts,
): CoverageRead | ParsedReport[] {
  const looked = facts.tracked
    .filter((p) => p.endsWith('/package.json'))
    .map((p) => `${p.slice(0, -'package.json'.length)}coverage/lcov.info`)
    .sort();
  const reports = looked.flatMap((name) => {
    const path = join(facts.top, name);
    const { index } = existsSync(path)
      ? readReportIndex(path)
      : { index: null };
    return index === null ? [] : [{ path, index }];
  });
  if (reports.length > 0) return reports;
  // A monorepo can track hundreds of package.json files; name the first few.
  const more = looked.length > 5 ? ` and ${looked.length - 5} more` : '';
  const named = [...DISCOVERED_REPORTS, ...looked.slice(0, 5)].join(', ');
  return absentCoverage(`no report at ${named}${more}`);
}

/**
 * Report entries by repo-relative path, for exact lookup only. A suffix match
 * would give a file a same-named stranger's coverage. An absolute key outside
 * the top level becomes a `../` path, which no tracked file has.
 */
function byRepoPath(index: ReportIndex, top: string) {
  const files = new Map<string, FileCoverage>();
  for (const [key, file] of Object.entries(index)) {
    const path = isAbsolute(key)
      ? relative(top, key).split(sep).join('/')
      : key;
    files.set(path, file);
  }
  return files;
}

function coverageFrom(reports: ParsedReport[], facts: GitFacts): CoverageRead {
  const name = reports
    .map((r) => relative(facts.top, r.path).split(sep).join('/'))
    .join(', ');
  const pcts = new Map<string, number>();
  for (const report of reports) {
    const anchored = anchorIndex(report.index, report.path, facts.top);
    const files = byRepoPath(anchored, facts.top);
    for (const path of facts.candidates) {
      const file = files.get(path);
      const pct = file === undefined ? null : linePct(file);
      if (pct !== null && !pcts.has(path)) pcts.set(path, pct);
    }
  }
  if (pcts.size === 0) {
    return absentCoverage(
      `${name} measured 0 of ${facts.candidates.length} source file(s)`,
    );
  }
  return {
    pctOf: (path) => pcts.get(path) ?? null,
    source: { status: 'measured', report: name, files_matched: pcts.size },
  };
}

function loadCoverage(
  explicit: ParsedReport | null,
  facts: GitFacts,
): CoverageRead {
  const reports = explicit === null ? discoverReport(facts) : [explicit];
  return Array.isArray(reports) ? coverageFrom(reports, facts) : reports;
}

function abstain(deps: MainDeps, why: string): never {
  deps.out(`Abstained: ${why}; no critical-areas file written.`);
  throw new CliExitError(EXIT_ABSTAINED);
}

function churnSource(facts: GitFacts): SignalSource {
  return facts.churnAbsentReason === null
    ? { status: 'measured', window_days: CHURN_WINDOW_DAYS }
    : {
        status: 'absent',
        reason: facts.churnAbsentReason,
        window_days: CHURN_WINDOW_DAYS,
      };
}

function signalsFor(
  paths: string[],
  facts: GitFacts,
  importers: ReadonlyMap<string, number> | null,
  pctOf: (path: string) => number | null,
): FileSignals[] {
  return paths.map((path) => ({
    path,
    churn: facts.churn === null ? null : (facts.churn.get(path) ?? 0),
    importers: importers === null ? null : (importers.get(path) ?? 0),
    coveragePct: pctOf(path),
  }));
}

const reportDropped = (deps: MainDeps, why: string, paths: string[]): void => {
  if (paths.length > 0) {
    deps.out(`Dropped symbols for ${why}: ${paths.map(showPath).join(', ')}.`);
  }
};

/** An explicit --out was chosen, and stands; the default may be refused. */
function resolveOut(
  opts: CriticalAreasOpts,
  top: string,
  deps: MainDeps,
): string {
  if (opts.out !== undefined) return resolve(deps.cwd(), opts.out);
  const out = defaultOut(top);
  if (out !== null) return out;
  // The link's target is the tree's text, so it stays out of the message.
  deps.err(
    `Refused to write: .canary does not resolve inside ${top}. Use --out to choose a path.`,
  );
  throw new CliExitError(1);
}

function runCriticalAreas(opts: CriticalAreasOpts, deps: MainDeps): void {
  const explicit = readExplicitReport(opts, deps);
  const facts = readGitFacts(resolve(opts.root ?? deps.cwd()));
  if (!facts.ok) return abstain(deps, facts.reason);
  if (facts.candidates.length === 0) {
    abstain(deps, `0 source files in HEAD of ${facts.top}`);
  }
  const out = resolveOut(opts, facts.top, deps);
  const { kept, dropped, rejected } = keepSymbols(out, facts.tracked);
  const candidates = new Set(facts.candidates);
  const extraPaths = [...kept.keys()].filter((p) => !candidates.has(p));
  const { counts, source } = countImporters(
    facts.top,
    facts.candidates,
    extraPaths,
  );
  const coverage = loadCoverage(explicit, facts);
  const doc = buildDocument({
    generated: new Date().toISOString(),
    base: facts.head,
    files: signalsFor(facts.candidates, facts, counts, coverage.pctOf),
    extras: signalsFor(extraPaths, facts, counts, coverage.pctOf),
    symbols: kept,
    sources: {
      churn: churnSource(facts),
      importers: source,
      coverage: coverage.source,
    },
  });
  if (doc.areas.length === 0) {
    abstain(deps, `every score is 0 across ${facts.candidates.length} file(s)`);
  }
  const failed = writeAtomically(out, jsonIndent2(doc) + '\n');
  if (failed !== null) {
    deps.err(`Could not write ${out}: ${failed}.`);
    throw new CliExitError(1);
  }
  deps.out(
    `Wrote ${out}: ${doc.areas.length} area(s) from ${doc.files_analyzed} file(s).`,
  );
  if (source.reason !== undefined) deps.out(`Importers: ${source.reason}.`);
  reportDropped(deps, 'paths that are not a tracked file in HEAD', dropped);
  reportDropped(
    deps,
    'paths whose list katana rejects (empty, not strings, or a name under 3 letters or digits)',
    rejected,
  );
}

export function buildCriticalAreasCommand(deps: MainDeps): Command {
  return new Command('critical-areas')
    .description(
      'Rank tracked source files by churn, importers and coverage, and write .canary/critical-areas.json for canary-katana.',
    )
    .option(
      '--root <dir>',
      'Any directory in the repository (default: current directory).',
    )
    .option(
      '--out <path>',
      'Output file (default: <repo top>/.canary/critical-areas.json).',
    )
    .option(
      '--coverage <file>',
      'Coverage report (default: the first conventional report found).',
    )
    .action((opts: CriticalAreasOpts) => {
      runCriticalAreas(opts, deps);
    });
}
