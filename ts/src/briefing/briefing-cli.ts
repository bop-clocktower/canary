/**
 * `canary briefing` (#593, PR1): print the FACTS half of a test charter for a
 * human tester, as Markdown on stdout.
 *
 * Exit codes follow the CLI-wide gate contract, and only two of them exist:
 *   - 0: a charter was written (including one that says "coverage unknown").
 *   - 3 (EXIT_ABSTAINED): the diff was empty, unparseable, or scoped to zero
 *     units after the guardian filters. Nothing is written.
 *
 * There is deliberately NO failure code. A gap in a charter is content, not a
 * failure, and this command is not a gate: it never changes a check's colour
 * and must never be mistaken for the guardian's verdict comment.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

import { CliExitError, jsonIndent2 } from '../cli-common.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import {
  type DiffResolutionDeps,
  type GitResult,
  detectMergeRef,
  readPrDiff,
  resolveHeadSha,
  warnIfEmptyCiDiff,
} from '../guardian/cli.js';
import { isSourcePath } from '../guardian/coverage.js';
import {
  coverageStatus,
  resolveCoverageWithInput,
} from '../guardian/diff-coverage/orchestrator.js';
import { type ChangedUnit, Fidelity } from '../guardian/diff-coverage/types.js';
import {
  type DiffProvenance,
  filterSkipped,
  filterTestSupportUnits,
  filterTestUnits,
  filterTypeOnlyUnits,
  findReexportOnly,
  loadGuardianConfig,
  provenanceLine,
  scopeDiff,
} from '../guardian/pr-check.js';
import type { MainDeps } from '../main-deps.js';
import { renderCharter } from './charter.js';
import {
  type BriefingFacts,
  type BriefingSkip,
  type ScopedUnit,
  assembleFacts,
} from './facts.js';
import { readInventoryIndex, readRankIndex } from './inputs.js';
import {
  type JudgmentResult,
  applyJudgment,
  parseJudgment,
} from './judgment.js';

interface BriefingOpts {
  diff?: string;
  coverage?: string;
  root?: string;
  config: string;
  json?: boolean;
  judgment?: string;
}

/**
 * Adapt {@link MainDeps} to the guardian's diff-resolution seam.
 *
 * Reusing `readPrDiff` rather than re-reading the diff here is the point: the
 * #369 trap (an omitted `--diff` falling back to a working-tree diff that is
 * empty on a clean CI checkout, so a run verifies nothing and still looks
 * fine) is fixed in exactly one place, and a second implementation would
 * silently reintroduce it.
 */
function diffDeps(deps: MainDeps): DiffResolutionDeps {
  return {
    out: (s) => deps.out(s),
    err: (s) => deps.err(s),
    readStdin: () => {
      try {
        return readFileSync(0, 'utf-8');
      } catch {
        return '';
      }
    },
    env: deps.env,
    runGit: (args, cwd): GitResult | null => {
      const res = deps.runSubprocess(
        'git',
        args,
        cwd === undefined ? {} : { cwd },
      );
      if (res.status === null) return null;
      return { code: res.status, stdout: res.stdout };
    },
  };
}

function skipEntries(units: ChangedUnit[], reason: string): BriefingSkip[] {
  return units.map((u) => ({ path: u.path, reason }));
}

/**
 * Apply the guardian's OWN filter chain to a scoped diff (spec D1).
 *
 * The order and the reasons mirror `pr-check`'s gate path so the charter and
 * the gate cannot disagree about what changed: a docs file, a test, a test
 * support module, a type-only module, a re-export barrel and a non-source file
 * are out of a charter for the same reasons they are out of the gate. Each one
 * is returned with its reason so the charter can show the edges of the plan.
 */
function scopeForBriefing(
  diffText: string,
  skipGlobs: string[],
  repoRoot: string,
): { kept: ChangedUnit[]; skipped: BriefingSkip[] } {
  const [keptSkip, skipped] = filterSkipped(scopeDiff(diffText), skipGlobs);
  const [keptTest, testUnits] = filterTestUnits(keptSkip);
  const [keptSupport, supportUnits] = filterTestSupportUnits(keptTest);
  const [keptTyped, typeOnlyUnits] = filterTypeOnlyUnits(keptSupport, repoRoot);
  const reexportPaths = findReexportOnly(diffText);
  const barrelUnits = keptTyped.filter((u) => reexportPaths.has(u.path));
  const keptBarrel = keptTyped.filter((u) => !reexportPaths.has(u.path));
  const nonSourceUnits = keptBarrel.filter((u) => !isSourcePath(u.path));
  return {
    kept: keptBarrel.filter((u) => isSourcePath(u.path)),
    skipped: [
      ...skipEntries(skipped, 'matched a guardian skip glob'),
      ...skipEntries(testUnits, 'is itself a test'),
      ...skipEntries(supportUnits, 'is test support, not code under test'),
      ...skipEntries(typeOnlyUnits, 'has no runtime content'),
      ...skipEntries(barrelUnits, 'is a re-export barrel'),
      ...skipEntries(nonSourceUnits, 'is not a source file'),
    ],
  };
}

/**
 * Run the guardian's Tier-0 coverage ladder over `units` (spec D1).
 *
 * Only a COVERAGE-VERIFIED result becomes a measurement. A unit judged at the
 * graph or heuristic tier carries `measured: null`, so it renders as "coverage
 * unknown" rather than as a covered unit — inference is not execution, and the
 * charter must not present it as such (ADR 0010).
 */
function measureCoverage(
  units: ChangedUnit[],
  repoRoot: string,
  coveragePath: string | null,
): { units: ScopedUnit[]; coverageStatus: ReturnType<typeof coverageStatus> } {
  const { results, coverage } = resolveCoverageWithInput(units, {
    coveragePath,
    repoRoot,
  });
  const byPath = new Map(results.map((r) => [r.unit.path, r]));
  return {
    units: units.map((unit) => {
      const result = byPath.get(unit.path);
      const verified =
        result !== undefined && result.fidelity === Fidelity.CoverageVerified;
      return {
        path: unit.path,
        added_ranges: unit.added_ranges,
        measured:
          verified && result !== undefined
            ? {
                covered: result.covered,
                evidence: result.evidence,
                uncovered_lines: result.uncovered_lines,
              }
            : null,
      };
    }),
    coverageStatus: coverageStatus(coverage),
  };
}

function abstain(reason: string, deps: MainDeps): never {
  deps.out(`Abstained: ${reason}; no charter written.`);
  throw new CliExitError(EXIT_ABSTAINED);
}

/**
 * Resolve the diff to brief on, abstaining rather than proceeding on anything
 * we cannot honestly scope. Returns the diff plus the guardian's own
 * provenance line for it.
 */
function resolveBriefingDiff(
  opts: BriefingOpts,
  resolver: DiffResolutionDeps,
  deps: MainDeps,
): { text: string; fileCount: number; provenance: string } {
  let resolved;
  try {
    resolved = readPrDiff(opts.diff ?? null, resolver);
  } catch (e) {
    // An unreadable `--diff` is an abstention, not a charter and not a
    // failure: we cannot say what changed, so we say exactly that.
    abstain(
      `the diff at '${opts.diff}' could not be read (${(e as Error).message})`,
      deps,
    );
  }

  const units = scopeDiff(resolved.text);
  warnIfEmptyCiDiff(resolved, units.length, resolver);
  if (resolved.text.trim() === '') {
    abstain(`the ${resolved.origin} diff was empty`, deps);
  }
  if (units.length === 0) {
    abstain(`the ${resolved.origin} diff scoped 0 changed files`, deps);
  }

  const headSha = resolved.head ?? resolveHeadSha(resolver);
  const provenance: DiffProvenance = {
    base: resolved.base,
    head: headSha,
    origin: resolved.origin,
    fileCount: units.length,
    ...(detectMergeRef(headSha, resolver) ? { mergeRef: true } : {}),
  };
  return {
    text: resolved.text,
    fileCount: units.length,
    provenance: provenanceLine(provenance),
  };
}

function runBriefing(opts: BriefingOpts, deps: MainDeps): void {
  const root = resolve(opts.root ?? deps.cwd());
  const [config, warning] = loadGuardianConfig(opts.config);
  if (warning !== null) deps.err(`WARNING: ${warning}`);

  const resolver = diffDeps(deps);
  const diff = resolveBriefingDiff(opts, resolver, deps);

  const { kept, skipped } = scopeForBriefing(
    diff.text,
    config.skip_globs,
    root,
  );
  const facts = assembleFacts({
    provenance: diff.provenance,
    ...measureCoverage(kept, root, opts.coverage ?? null),
    skipped,
    imports: readInventoryIndex(root),
    ranks: readRankIndex(root),
  });
  if (facts === null) {
    abstain(
      `all ${diff.fileCount} changed file(s) were filtered out, so there is ` +
        'nothing for a tester to work through',
      deps,
    );
  }

  const judgment = loadJudgment(opts.judgment, facts, deps);
  deps.out(
    opts.json === true
      ? jsonIndent2(judgment === undefined ? facts : { ...facts, judgment })
      : renderCharter(facts, judgment),
  );
}

/** Read skill judgment; any problem degrades to a facts-only charter, never exit 1. */
function loadJudgment(
  path: string | undefined,
  facts: BriefingFacts,
  deps: MainDeps,
): JudgmentResult | undefined {
  if (path === undefined) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    deps.err(
      `WARNING: judgment ignored: '${path}' could not be read (${(e as Error).message})`,
    );
    return undefined;
  }
  const parsed = parseJudgment(raw);
  if (typeof parsed === 'string') {
    deps.err(`WARNING: judgment ignored: ${parsed}`);
    return undefined;
  }
  return applyJudgment(parsed, facts.units);
}

export function buildBriefingCommand(deps: MainDeps): Command {
  return new Command('briefing')
    .description(
      'Print the facts half of a test charter for a diff (advisory, never a gate).',
    )
    .option(
      '--diff <file>',
      "Unified diff to read ('-' for stdin). Omitted: the PR diff in CI, else the working tree.",
    )
    .option('--coverage <file>', 'Coverage report for the Tier-0 pass.')
    .option('--root <dir>', 'Repository root (default: current directory).')
    .option(
      '--config <file>',
      'harness.config.json to read guardian skip globs from.',
      'harness.config.json',
    )
    .option('--json', 'Emit BriefingFacts JSON instead of Markdown.')
    .option(
      '--judgment <file>',
      'Skill-written judgment JSON (mission, verify, edge_cases); items must cite path:line in the added ranges.',
    )
    .action((opts: BriefingOpts) => {
      runBriefing(opts, deps);
    });
}
