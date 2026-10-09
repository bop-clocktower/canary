// alarm -- fire only when a deletion removes the last coverage of a hot symbol.
//
// Most test deletions are legitimate, so katana is silent by default and
// records everything. It alarms in exactly one situation: the deleted test was
// the *last* test covering a symbol `critical-areas.json` marks high-risk. When
// that file is missing or malformed the alarm degrades to recording-only and
// says so; a gate that manufactures failures on missing data gets muted, and a
// muted gate is worse than no gate.
//
// "Still covered" means a test NEAR the area still names the symbol (#1242,
// see nearby.mjs). An area the gate still cannot alarm on is reported as NOT
// ASSESSED, so "0 alarms" is never mistaken for "every area checked".

import {
  areaContext,
  coveringSymbol,
  MIN_DERIVED_SYMBOL,
  nameCovers,
} from './areas.mjs';
import {
  dirsOf,
  importsAny,
  isNear,
  ownsTest,
  significantDirs,
} from './nearby.mjs';
import { testIndex } from './testindex.mjs';

export { areaSymbols, loadCriticalAreas } from './areas.mjs';
export { repoTestFiles } from './testindex.mjs';

export const DEGRADED_NOTICE =
  'critical-area data unavailable, recording only, not alarming';

// risk_score at or above this makes a name-matched last-coverage loss CRITICAL;
// below it the loss is still real but ranked HIGH.
const CRITICAL_RISK = 0.7;

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
export const NotAssessed = {
  // The critical-areas entry fails the contract (a bad path or symbols list).
  INVALID_AREA: 'invalid-area',
  // No declared symbols and a basename too short to match on.
  NO_SYMBOL: 'no-symbol',
  // A test near the area names the symbol without importing the area or being
  // named for it, so deleting the area's real tests always leaves it "covered".
  SYMBOL_SATURATED: 'symbol-saturated',
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

/** A test near the area (or importing it) still names one of its symbols. */
function nameCoverageRemains(index, ctx) {
  return index.some(
    (e) =>
      (isNear(e.rel, ctx) || importsAny(e, ctx)) &&
      e.names.some((name) => nameCovers(name, ctx.syms)),
  );
}

function dirCoverageRemains(index, areaDirs) {
  return index.some(
    (e) => dirsOf(e.rel).some((d) => areaDirs.has(d)) && e.names.length > 0,
  );
}

/** Name-matched grade, or null when a nearby test still covers the area. */
function nameGrade(ctx, index) {
  if (nameCoverageRemains(index(), ctx)) return null;
  const severity =
    ctx.risk >= CRITICAL_RISK ? Severity.CRITICAL : Severity.HIGH;
  return { fidelity: Fidelity.NAME_MATCHED, severity };
}

/** Directory-only grade, or null when unrelated or the directory is covered. */
function dirGrade(deletion, ctx, index) {
  const areaDirs = significantDirs(ctx.path);
  const delDirs = new Set(dirsOf(deletion.file));
  if (![...areaDirs].some((d) => delDirs.has(d))) return null;
  if (dirCoverageRemains(index(), areaDirs)) return null;
  return { fidelity: Fidelity.HEURISTIC, severity: Severity.MEDIUM };
}

function candidateFor(deletion, ctx, index) {
  if (ctx.problems) return null; // invalid: reported as not assessed instead
  const grade =
    ctx.syms.size && nameCovers(deletion.name, ctx.syms)
      ? nameGrade(ctx, index)
      : dirGrade(deletion, ctx, index);
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
function findingsFor(deletions, contexts, index) {
  const findings = [];
  for (const deletion of deletions) {
    let best = null;
    for (const ctx of contexts) {
      const c = candidateFor(deletion, ctx, index);
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
    if (!isNear(e.rel, ctx) || ownsTest(e.rel, ctx) || importsAny(e, ctx)) {
      continue;
    }
    const name = e.names.find((n) => nameCovers(n, ctx.syms));
    if (name === undefined) continue;
    return {
      reason: NotAssessed.SYMBOL_SATURATED,
      evidence:
        `'${name}' in ${e.rel} matches '${coveringSymbol(name, ctx.syms)}' ` +
        `but neither imports ${ctx.path} nor is named for it, so ` +
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
        `basename of ${ctx.path} has under ${MIN_DERIVED_SYMBOL} letters or ` +
        'digits to match a test title on, and no symbols are declared',
    };
  }
  return saturation(index, ctx);
}

/** Could a deletion have taken coverage from this area, by any path we model? */
function atStake(deletions, ctx) {
  const areaDirs = significantDirs(ctx.path);
  return deletions.some(
    (d) =>
      (ctx.syms.size && nameCovers(d.name, ctx.syms)) ||
      isNear(d.file, ctx) ||
      dirsOf(d.file).some((x) => areaDirs.has(x)),
  );
}

function notAssessedFor(deletions, contexts, index) {
  return contexts
    .map((ctx) => {
      const why = notAssessedReason(index(), ctx);
      return (
        why && { area: ctx.path, ...why, atStake: atStake(deletions, ctx) }
      );
    })
    .filter(Boolean)
    .sort((a, b) => a.area.localeCompare(b.area));
}

/**
 * The whole verdict: last-coverage findings, plus the denominator -- how many
 * areas were read and which of them the gate cannot alarm on. `atStake` marks
 * a not-assessed area some deletion in this diff relates to: for those, no
 * finding means "could not tell", not "fine".
 * @returns {{findings: Finding[], total: number, notAssessed: NotAssessedArea[]}}
 */
export function assess(deletions, areas, repo) {
  if (!areas.available) return { findings: [], total: 0, notAssessed: [] };
  const index = testIndex(repo);
  const contexts = areas.areas.map((a, i) =>
    areaContext(a, areas.problems?.get(i) ?? null),
  );
  return {
    findings: findingsFor(deletions, contexts, index),
    total: contexts.length,
    notAssessed: notAssessedFor(deletions, contexts, index),
  };
}

/** Return last-coverage-removed findings; empty when data is unavailable. */
export function buildFindings(deletions, areas, repo) {
  return assess(deletions, areas, repo).findings;
}
