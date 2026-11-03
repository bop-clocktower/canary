/**
 * `canary critical-areas` (#1529): writes `.canary/critical-areas.json`, which
 * canary-katana alarms against. See docs/guides/critical-areas.md.
 *
 * Exit codes follow the CLI-wide gate contract:
 *   - 0: the file was written.
 *   - 2: an explicit --coverage report is missing or unparseable.
 *   - 3 (EXIT_ABSTAINED): nothing to rank, so NOTHING is written. An empty map
 *     would also overwrite a good one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';

import { CliExitError, jsonIndent2 } from '../cli-common.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import type { MainDeps } from '../main-deps.js';
import { readGitFacts, type GitFacts } from './git-signals.js';
import { countImporters } from './importers.js';
import {
  buildDocument,
  CHURN_WINDOW_DAYS,
  type FileSignals,
  type SignalSource,
} from './scoring.js';

interface CriticalAreasOpts {
  root?: string;
  out?: string;
  coverage?: string;
}

function abstain(deps: MainDeps, why: string): never {
  deps.out(`Abstained: ${why}; no critical-areas file written.`);
  throw new CliExitError(EXIT_ABSTAINED);
}

function churnSource(facts: GitFacts): SignalSource {
  return facts.churn === null
    ? {
        status: 'absent',
        reason: 'shallow clone: every file reads as one commit',
        window_days: CHURN_WINDOW_DAYS,
      }
    : { status: 'measured', window_days: CHURN_WINDOW_DAYS };
}

function signalsFor(
  paths: string[],
  facts: GitFacts,
  importers: ReadonlyMap<string, number>,
  pctOf: (path: string) => number | null,
): FileSignals[] {
  return paths.map((path) => ({
    path,
    churn: facts.churn === null ? null : (facts.churn.get(path) ?? 0),
    importers: importers.get(path) ?? 0,
    coveragePct: pctOf(path),
  }));
}

function runCriticalAreas(opts: CriticalAreasOpts, deps: MainDeps): void {
  const facts = readGitFacts(resolve(opts.root ?? deps.cwd()));
  if (!facts.ok) return abstain(deps, facts.reason);
  if (facts.candidates.length === 0) {
    abstain(deps, `0 source files in HEAD of ${facts.top}`);
  }
  const out =
    opts.out === undefined
      ? join(facts.top, '.canary', 'critical-areas.json')
      : resolve(deps.cwd(), opts.out);
  const importers = countImporters(facts.top, facts.candidates);
  const doc = buildDocument({
    generated: new Date().toISOString(),
    base: facts.head,
    files: signalsFor(facts.candidates, facts, importers, () => null),
    extras: [],
    symbols: new Map(),
    sources: {
      churn: churnSource(facts),
      importers: { status: 'measured' },
      coverage: { status: 'absent', reason: 'no coverage report read' },
    },
  });
  if (doc.areas.length === 0) {
    abstain(deps, `every score is 0 across ${facts.candidates.length} file(s)`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, jsonIndent2(doc) + '\n', 'utf-8');
  deps.out(
    `Wrote ${out}: ${doc.areas.length} area(s) from ${doc.files_analyzed} file(s).`,
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
