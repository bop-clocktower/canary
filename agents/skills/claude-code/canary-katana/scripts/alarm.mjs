// alarm -- fire only when a deletion removes the last coverage of a hot symbol.
//
// Most test deletions are legitimate, so katana is silent by default and
// records everything. It alarms in exactly one situation: the deleted test was
// the *last* test covering a symbol `critical-areas.json` marks high-risk. When
// that file is missing or malformed the alarm degrades to recording-only and
// says so; a gate that manufactures failures on missing data gets muted, and a
// muted gate is worse than no gate.
//
// Both ends are tied to the area by proximity (#1242, ties.mjs, nearby.mjs):
// the deleted test must have belonged to it, and "still covered" means a test
// near the area, or importing it, remains. An area the gate still cannot alarm
// on -- or, for this diff, cannot decide (#1253: a deleted test it cannot tie
// to the area, and no remaining test it can) -- is reported as NOT ASSESSED, so
// "0 alarms" is never mistaken for "every area checked".

import {
  areaContext,
  areaSymbols,
  coveringSymbol,
  CRITICAL_RISK,
  loadCriticalAreas,
  MIN_DERIVED_SYMBOL,
  nameCovers,
} from './areas.mjs';
import { importKind } from './imports.mjs';
import {
  dirsOf,
  inRootTestDir,
  isNear,
  ownsTest,
  significantDirs,
} from './nearby.mjs';
import { repoTestFiles, scopeOf } from './testindex.mjs';
import { covers, related, tiedDeletion, tiedToArea } from './ties.mjs';

// Imported then re-exported (not `export ... from`): the entropy scanner's
// reachability model drops a module that is both imported and re-exported.
export { areaSymbols, loadCriticalAreas, repoTestFiles };

export const DEGRADED_NOTICE =
  'critical-area data unavailable, recording only, not alarming';

export const Fidelity = {
  NAME_MATCHED: { value: 'name-matched', rank: 0 },
  HEURISTIC: { value: 'heuristic', rank: 1 },
};

export const Severity = {
  CRITICAL: { value: 'critical', sortKey: 0 },
  HIGH: { value: 'high', sortKey: 1 },
  MEDIUM: { value: 'medium', sortKey: 2 },
};

/**
 * Why katana cannot alarm on an area. Each is a reason a name-matched
 * last-coverage alarm is impossible for it, whatever the diff deletes.
 */
const NotAssessed = {
  // The critical-areas entry fails the contract (a bad path or symbols list).
  INVALID_AREA: 'invalid-area',
  // No declared symbols and a basename too short to match on.
  NO_SYMBOL: 'no-symbol',
  // A test near the area names the symbol without importing the area or being
  // named for it, so deleting the area's real tests always leaves it "covered".
  SYMBOL_SATURATED: 'symbol-saturated',
  // The diff deleted a test beside the area that katana cannot tie to it (no
  // import of it, not named for it -- e.g. it drives the area over HTTP), and
  // no remaining test can be tied to it either (#1253). Coverage may have
  // gone with that test or never existed: katana cannot tell, so it says so.
  UNLINKED: 'unlinked',
};

/**
 * @typedef {{kind: string, test: string, file: string, area: string,
 *            fidelity: {value: string, rank: number},
 *            severity: {value: string, sortKey: number},
 *            evidence: string}} Finding
 * @typedef {{area: string, reason: string, evidence: string,
 *            atStake: boolean}} NotAssessedArea
 */

/** JSON-contract shape of a finding. */
export function findingToDict(f) {
  return {
    kind: f.kind,
    test: f.test,
    file: f.file,
    area: f.area,
    fidelity: f.fidelity.value,
    severity: f.severity.value,
    evidence: f.evidence,
  };
}

/** JSON-contract shape of a not-assessed area. */
export function notAssessedToDict(n) {
  return {
    area: n.area,
    reason: n.reason,
    evidence: n.evidence,
    at_stake: n.atStake,
  };
}

function dirCoverageRemains(index, areaDirs) {
  return index.some(
    (e) => dirsOf(e.rel).some((d) => areaDirs.has(d)) && e.names.length > 0,
  );
}

/** Name-matched grade, or null when a test near the area still covers it. */
function nameGrade(ctx, scope) {
  if (scope.index().some((e) => covers(e, ctx))) return null;
  const severity =
    ctx.risk >= CRITICAL_RISK ? Severity.CRITICAL : Severity.HIGH;
  return { fidelity: Fidelity.NAME_MATCHED, severity };
}

/** Directory-only grade, or null when unrelated or the directory is covered. */
function dirGrade(deletion, ctx, scope) {
  const areaDirs = significantDirs(ctx.path);
  const delDirs = new Set(dirsOf(deletion.file));
  if (![...areaDirs].some((d) => delDirs.has(d))) return null;
  if (dirCoverageRemains(scope.index(), areaDirs)) return null;
  return { fidelity: Fidelity.HEURISTIC, severity: Severity.MEDIUM };
}

function candidateFor(deletion, ctx, scope) {
  if (ctx.problems) return null; // invalid: reported as not assessed instead
  const grade = tiedDeletion(deletion, ctx, scope)
    ? nameGrade(ctx, scope)
    : dirGrade(deletion, ctx, scope);
  if (grade === null) return null;
  return {
    kind: 'last-coverage-removed',
    test: deletion.name,
    file: deletion.file,
    area: ctx.path,
    ...grade,
    evidence: `${deletion.name} was the last test covering ${ctx.path}`,
  };
}

// Lower (fidelity.rank, sortKey) wins, element-wise: name-matched outranks
// heuristic, then severity.
const outranks = (a, b) =>
  a.fidelity.rank !== b.fidelity.rank
    ? a.fidelity.rank < b.fidelity.rank
    : a.severity.sortKey < b.severity.sortKey;

/** Keep the best candidate per deletion across every area. */
function findingsFor(deletions, contexts, scope) {
  const findings = [];
  for (const deletion of deletions) {
    let best = null;
    for (const ctx of contexts) {
      const c = candidateFor(deletion, ctx, scope);
      if (c !== null && (best === null || outranks(c, best))) best = c;
    }
    if (best !== null) findings.push(best);
  }
  return findings.sort(
    (a, b) =>
      a.severity.sortKey - b.severity.sortKey ||
      a.file.localeCompare(b.file) ||
      a.test.localeCompare(b.test),
  );
}

/** The first near test that names the symbol without being tied to the area. */
function saturation(index, ctx) {
  for (const e of index) {
    if (!isNear(e.rel, ctx) || tiedToArea(e, ctx)) continue;
    const name = e.names.find((n) => nameCovers(n, ctx.syms));
    if (name === undefined) continue;
    return {
      reason: NotAssessed.SYMBOL_SATURATED,
      evidence:
        `'${name}' in ${e.rel} matches '${coveringSymbol(name, ctx.syms)}' ` +
        `but neither imports ${ctx.path} nor is its own test file, so ` +
        `${ctx.path} always reads as covered; declare narrower symbols`,
    };
  }
  return null;
}

/**
 * Why the gate cannot alarm on this area, or null when it can. Saturation is
 * read from the tree on disk, which is the tree before the diff minus what the
 * diff deleted: a test the diff removed cannot keep anything covered.
 */
function notAssessedReason(index, ctx) {
  if (ctx.problems) {
    return {
      reason: NotAssessed.INVALID_AREA,
      evidence: `critical-areas entry is invalid: ${ctx.problems.join('; ')}`,
    };
  }
  if (!ctx.syms.size) {
    return {
      reason: NotAssessed.NO_SYMBOL,
      evidence:
        `basename of ${ctx.path} gives no symbol of ${MIN_DERIVED_SYMBOL}+ ` +
        'letters or digits (role words like service are skipped), and no ' +
        'symbols are declared',
    };
  }
  return saturation(index, ctx);
}

/**
 * Did this diff touch an area katana cannot assess? Only a deleted test named
 * for the area or importing it does: proximity alone (any root `tests/` file)
 * would put every such area at stake on every diff.
 */
const atStake = (deletions, ctx, scope) =>
  deletions.some(
    (d) =>
      ownsTest(d.file, ctx) ||
      importKind(scope.importsOf(d.file), ctx) !== null,
  );

/** How a deletion relates to the area, for the evidence line (#1255). */
const whereRelated = (d, ctx) =>
  inRootTestDir(d.file) && !isNear(d.file, ctx)
    ? `from the root test directory, and ${ctx.path} is high-risk,`
    : `beside ${ctx.path}`;

/**
 * An assessable area this diff left undecidable (#1253): a related test was
 * deleted that katana cannot tie to the area, none was tied to it, and no
 * remaining test can be. Always at stake -- it exists only because of the diff.
 */
function unlinked(deletions, ctx, scope) {
  if (deletions.some((d) => tiedDeletion(d, ctx, scope))) return null;
  const untied = deletions.find((d) => related(d, ctx));
  if (untied === undefined) return null;
  if (scope.index().some((e) => covers(e, ctx))) return null;
  return {
    reason: NotAssessed.UNLINKED,
    evidence:
      `${untied.file} was deleted ${whereRelated(untied, ctx)} but neither ` +
      'imports it ' +
      'nor is named for it, and no remaining test imports it or is its own ' +
      'test file, so katana cannot tell whether its coverage went too; add a ' +
      'test that imports it',
  };
}

function notAssessedFor(deletions, contexts, scope, findings) {
  const alarmed = new Set(findings.map((f) => f.area));
  return contexts
    .map((ctx) => {
      const why = notAssessedReason(scope.index(), ctx);
      if (why) {
        return {
          area: ctx.path,
          ...why,
          atStake: atStake(deletions, ctx, scope),
        };
      }
      const gap = alarmed.has(ctx.path)
        ? null
        : unlinked(deletions, ctx, scope);
      return gap && { area: ctx.path, ...gap, atStake: true };
    })
    .filter(Boolean)
    .sort((a, b) => a.area.localeCompare(b.area));
}

/**
 * The whole verdict: last-coverage findings, plus the denominator -- how many
 * areas were read and which of them the gate cannot alarm on. `atStake` marks
 * a not-assessed area a deletion in this diff was tied to: for those, no
 * finding means "could not tell", not "fine". Pass the diff text so a deleted
 * file's imports can be read.
 * @returns {{findings: Finding[], total: number, notAssessed: NotAssessedArea[]}}
 */
export function assess(deletions, areas, repo, diff = '') {
  if (!areas.available) return { findings: [], total: 0, notAssessed: [] };
  const scope = scopeOf(repo, diff);
  const contexts = areas.areas.map((a, i) =>
    areaContext(a, areas.problems?.get(i) ?? null),
  );
  const findings = findingsFor(deletions, contexts, scope);
  return {
    findings,
    total: contexts.length,
    notAssessed: notAssessedFor(deletions, contexts, scope, findings),
  };
}

/** Return last-coverage-removed findings; empty when data is unavailable. */
export function buildFindings(deletions, areas, repo, diff = '') {
  return assess(deletions, areas, repo, diff).findings;
}
